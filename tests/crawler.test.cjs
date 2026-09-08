const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../boss_company_crawler.user.js'), 'utf8');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
function element() {
    return { textContent: '', value: '20', hidden: false, disabled: false, className: '',
        children: {}, set innerHTML(html) {
            for (const match of html.matchAll(/id="([^"]+)"/g)) this.children[match[1]] = element();
        }, querySelector(selector) { return this.children[selector.slice(1)] || null; },
        appendChild() {}, remove() {}, click() {}, setAttribute() {}, getAttribute() { return null; } };
}
function harness({ saved = {}, fetcher } = {}) {
    const timers = new Map(), requests = [], writes = [];
    let timerId = 0, failWrite = false;
    const document = { cards: [], body: element(), getElementById: () => null,
        createElement: element, querySelectorAll() { return this.cards; } };
    const storage = new Map(Object.entries(saved));
    const sandbox = {
        document, location: { href: 'https://www.zhipin.com/web/geek/job?city=101311020&query=test&salary=406' },
        URL, URLSearchParams, AbortController, Blob, console,
        GM_addStyle() {}, GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => { if (failWrite) throw new Error('disk full'); storage.set(key, value); writes.push(value); },
        setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
        clearTimeout: id => timers.delete(id), setInterval() {},
        window: { addEventListener() {} }, confirm: () => true,
        fetch: (url, options) => {
            requests.push({ url, options });
            return fetcher ? fetcher(url, options, requests.length) : Promise.resolve(reply([job('1', '测试公司')], false));
        }
    };
    const instrumented = source.replace(/\}\)\(\);\s*$/, `globalThis.api = {
        parsePage, domItems, buildCSV, csvCell, crawlLoop, stopRun, resetProgress, syncContext,
        collectCurrentPage, saveState, searchContext,
        get state() { return state; }, get activeRun() { return activeRun; },
        get ui() { return ui; }, get legacyItems() { return legacyItems; }
    }; })();`);
    vm.runInNewContext(instrumented, sandbox, { filename: 'boss_company_crawler.user.js' });
    return { api: sandbox.api, sandbox, storage, writes, requests, timers, document,
        set failWrite(value) { failWrite = value; },
        fireDelay() {
            const entry = [...timers].find(([, timer]) => timer.ms >= 4000 && timer.ms <= 7000);
            assert.ok(entry, 'expected an inter-page delay'); timers.delete(entry[0]); entry[1].fn();
        },
        fireTimeout() {
            const entry = [...timers].find(([, timer]) => timer.ms === 20000);
            assert.ok(entry); timers.delete(entry[0]); entry[1].fn();
        }
    };
}
const job = (id, name) => ({ encryptJobId: id, companyName: name, brandName: '品牌简称' });
const json = (jobs, hasMore) => ({ code: 0, zpData: { jobList: jobs, hasMore } });
const reply = (jobs, hasMore) => ({ ok: true, json: async () => json(jobs, hasMore) });
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('inherits current URL filters and ignores current UI page for task identity', () => {
    const h = harness();
    const first = h.api.searchContext().key;
    h.sandbox.location.href += '&page=9&pageSize=60';
    assert.equal(h.api.searchContext().key, first);
    assert.equal(h.api.searchContext().params.get('salary'), '406');
});

test('prefers companyName, falls back to brandName, rejects missing jobList', () => {
    const h = harness();
    const result = h.api.parsePage(json([job('1', '完整名称'), { brandName: '显示名' }, { companyName: '截断…' }], false));
    assert.deepEqual(Array.from(result.items, x => x.name), ['完整名称', '显示名']);
    assert.throws(() => h.api.parsePage({ code: 0, zpData: {} }), /jobList/);
    assert.throws(() => h.api.parsePage({ code: 37, message: 'verify' }), /verify/);
});

test('DOM checks parent title and rejects both literal ellipsis styles', () => {
    const h = harness();
    h.document.cards = ['完整标题', '', ''].map((title, index) => {
        const child = { getAttribute: () => null, textContent: ['简称...', '无标题…', '无标题...'][index] };
        const parent = { getAttribute: () => title, querySelector: () => child };
        return { querySelector: () => parent };
    });
    assert.deepEqual(Array.from(h.api.domItems(), x => x.name), ['完整标题']);
});

test('deduplicates at ingestion, stores checkpoint and hasMore=false stops immediately', async () => {
    const h = harness({ fetcher: async () => reply([job('1', ' 同一公司 '), job('2', '同一公司')], false) });
    await h.api.crawlLoop();
    assert.equal(h.requests.length, 1);
    assert.equal(h.api.state.companies.length, 1);
    assert.equal(h.api.state.pagesDone, 1);
    assert.equal(h.api.state.completed, true);
    assert.equal(h.api.activeRun, null);
    assert.match(h.api.ui.status.textContent, /已到末页/);
    const saved = JSON.parse(h.writes[0]);
    assert.equal('running' in Object.values(saved.datasets)[0], false);
    assert.match(h.requests[0].url, /salary=406/);
    assert.match(h.requests[0].url, /page=1/);
});

test('rapid pause/restart and late response cannot duplicate loops or overwrite new results', async () => {
    const old = deferred();
    const h = harness({ fetcher: (_, __, count) => count === 1 ? old.promise : Promise.resolve(reply([job('new', '新请求')], false)) });
    const first = h.api.crawlLoop();
    await h.api.crawlLoop();
    assert.equal(h.requests.length, 1);
    h.api.stopRun();
    assert.equal(h.requests[0].options.signal.aborted, true);
    await h.api.crawlLoop();
    old.resolve(reply([job('old', '迟到数据')], true));
    await first;
    assert.deepEqual(Array.from(h.api.state.companies, x => x.name), ['新请求']);
    assert.equal(h.requests.length, 2);
});

test('clear cancels in-flight request and late response cannot repopulate cleared data', async () => {
    const pending = deferred();
    const h = harness({ fetcher: () => pending.promise });
    const task = h.api.crawlLoop();
    h.api.resetProgress(true);
    pending.resolve(reply([job('1', '迟到数据')], false));
    await task;
    assert.equal(h.api.state.companies.length, 0);
    assert.equal(h.api.state.pagesDone, 0);
});

test('changing URL during request isolates datasets and rejects old query results', async () => {
    const pending = deferred();
    const h = harness({ fetcher: () => pending.promise });
    const task = h.api.crawlLoop();
    h.sandbox.location.href = 'https://www.zhipin.com/web/geek/job?query=different';
    pending.resolve(reply([job('1', '旧搜索')], false));
    await task;
    assert.equal(h.api.state.companies.length, 0);
    assert.match(h.api.state.label, /different/);
    assert.equal(h.api.activeRun, null);
});

test('API error stops without DOM fallback or advancing checkpoint', async () => {
    const h = harness({ fetcher: async () => ({ ok: false, status: 403 }) });
    h.document.querySelectorAll = () => { throw new Error('must not fall back'); };
    await h.api.crawlLoop();
    assert.equal(h.requests.length, 1);
    assert.equal(h.api.state.pagesDone, 0);
    assert.match(h.api.ui.status.textContent, /403/);
});

test('repeated job page stops without inflated page count', async () => {
    const h = harness({ fetcher: async () => reply([job('same-id', '同一公司')], true) });
    const task = h.api.crawlLoop();
    await flush(); h.fireDelay(); await task;
    assert.equal(h.requests.length, 2);
    assert.equal(h.api.state.pagesDone, 1);
    assert.match(h.api.ui.status.textContent, /已经采集过/);
});

test('different job pages with the same company do not falsely trigger repeated-page detection', async () => {
    const h = harness({ fetcher: async (_, __, count) => reply([job(String(count), '同一公司')], count < 2) });
    const task = h.api.crawlLoop();
    await flush(); h.fireDelay(); await task;
    assert.equal(h.api.state.pagesDone, 2);
    assert.equal(h.api.state.companies.length, 1);
    assert.equal(h.api.state.completed, true);
});

test('single empty page stops; contradictory empty page is not marked complete', async () => {
    for (const hasMore of [undefined, false, true]) {
        const h = harness({ fetcher: async () => reply([], hasMore) });
        await h.api.crawlLoop();
        assert.equal(h.requests.length, 1);
        assert.equal(h.api.state.pagesDone, 0);
        assert.equal(h.api.state.completed, hasMore !== true);
    }
});

test('request timeout aborts fetch and retains checkpoint', async () => {
    const h = harness({ fetcher: (_, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) });
    const task = h.api.crawlLoop();
    h.fireTimeout(); await task;
    assert.equal(h.api.state.pagesDone, 0);
    assert.match(h.api.ui.status.textContent, /20 秒/);
});

test('storage failure stops loop but keeps current memory data available for export', async () => {
    const h = harness(); h.failWrite = true;
    await h.api.crawlLoop();
    assert.equal(h.api.activeRun, null);
    assert.equal(h.api.state.companies.length, 1);
    assert.equal(h.api.state.pagesDone, 0);
    assert.equal(h.api.state.completed, false);
    assert.match(h.api.ui.status.textContent, /保存失败/);
    assert.match(h.api.buildCSV(h.api.state.companies), /测试公司/);
    h.failWrite = false;
    await h.api.crawlLoop();
    assert.match(h.requests[1].url, /page=1/);
    assert.equal(h.api.state.pagesDone, 1);
});

test('old running flag and inflated pages are not migrated, but deduplicated companies remain exportable', () => {
    const h = harness({ saved: { boss_company_crawler_v1: JSON.stringify({
        companies: [{ name: '老公司', source: 'dom' }, { name: '老公司' }], running: true, pagesDone: 900
    }) } });
    assert.equal(h.api.activeRun, null);
    assert.equal(h.api.state.pagesDone, 0);
    assert.equal(h.api.state.companies.length, 0);
    assert.equal(h.api.legacyItems.length, 1);
});

test('reload resumes saved query checkpoint without auto-running', async () => {
    const h = harness({ fetcher: async () => reply([job('1', '已存公司')], true) });
    h.api.ui.limit.value = '1';
    await h.api.crawlLoop();
    const next = harness({ saved: Object.fromEntries(h.storage) });
    assert.equal(next.api.state.pagesDone, 1);
    assert.equal(next.api.state.companies.length, 1);
    assert.equal(next.api.activeRun, null);
    await next.api.crawlLoop();
    assert.match(next.requests[0].url, /page=2/);
});

test('manual collection deduplicates and does not increment API page progress', () => {
    const h = harness();
    const link = { getAttribute: () => '当前页公司', textContent: '当前页公司', querySelector: () => null };
    h.document.cards = [{ querySelector: () => link }];
    h.api.collectCurrentPage(); h.api.collectCurrentPage();
    assert.equal(h.api.state.companies.length, 1);
    assert.equal(h.api.state.pagesDone, 0);
    assert.equal(h.api.state.companies[0].source, 'DOM');
});

test('CSV escapes quotes/newlines, adds UTF-8 BOM, and neutralizes formulas', () => {
    const h = harness();
    assert.equal(h.api.csvCell(' =HYPERLINK("x")'), '"\' =HYPERLINK(""x"")"');
    assert.equal(h.api.csvCell('\t@SUM(1)'), '"\'\t@SUM(1)"');
    assert.equal(h.api.csvCell('a,"b"\nc'), '"a,""b""\nc"');
    assert.ok(h.api.buildCSV([{ name: '公司' }]).startsWith('\uFEFF'));
    assert.match(h.api.buildCSV([{ name: '公司' }]), /未工商核验/);
});
