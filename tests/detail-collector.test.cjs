const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../boss_company_crawler.user.js'), 'utf8');

function node(text = '') {
    return {
        textContent: text, innerText: text, children: {}, hidden: false, value: '', checked: true,
        href: '', title: '', parentElement: null,
        set innerHTML(html) {
            this._html = html;
            for (const match of html.matchAll(/id="([^"]+)"/g)) this.children[match[1]] = node();
        },
        get innerHTML() { return this._html || ''; },
        querySelector(selector) { return this.children[selector.slice(1)] || null; },
        querySelectorAll() { return []; },
        getAttribute(name) { return this[name] || null; },
        setAttribute() {}, appendChild() {}, remove() {}, click() {},
        getClientRects() { return this.hidden ? [] : [{}]; },
        closest(selector) { return selector.includes('#bp-panel') && this.inPanel ? this : null; }
    };
}

function locationFor(initial, navigations) {
    return {
        _href: initial,
        get href() { return this._href; },
        set href(value) { this._href = new URL(value, this._href).href; },
        get origin() { return new URL(this._href).origin; },
        get pathname() { return new URL(this._href).pathname; },
        assign(value) { this.href = value; navigations.push(this.href); }
    };
}

function harness({ url = 'https://www.zhipin.com/web/geek/jobs?query=外贸业务员&city=101210900', saved = {}, businessText = '' } = {}) {
    const timers = new Map(), navigations = [], downloads = [];
    let timerId = 0, currentTime = 100000, failStorage = false;
    const cards = [], companyLinks = [], securityNodes = [];
    const businessNodes = businessText ? [node(businessText)] : [];
    const document = {
        body: node(businessText), cards, companyLinks, businessNodes, securityNodes,
        getElementById() { return null; }, createElement: () => node(),
        querySelectorAll(selector) {
            if (selector.startsWith('.job-card-wrapper')) return cards;
            if (selector.startsWith('li, dl')) return businessNodes;
            if (selector === 'a[href*="/gongsi/"]') return companyLinks;
            if (selector.startsWith('[role="dialog"]')) return securityNodes;
            return [];
        }
    };
    const location = locationFor(url, navigations);
    const sandbox = {
        document, location, URL, URLSearchParams, Blob, console,
        Date: class extends Date { static now() { return currentTime; } },
        Math, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        GM_addStyle() {}, GM_getValue: (key, fallback) => saved[key] ?? fallback,
        GM_setValue: (key, value) => { if (failStorage) throw new Error('quota'); saved[key] = value; },
        GM_download(options) { downloads.push(options); },
        setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }, confirm: () => true
    };
    const instrumented = source.replace(/\}\)\(\);\s*$/, `globalThis.api = {
        pageContext, normalizeRecord, normalizeRecords, recordKey, scanList, pendingRecords, retryFailed,
        startBusinessRun, visitNext, extractBusiness, findField, securityBlocked, finishDetail, collectThisDetail,
        buildCSV, csvCell, stats, getRun, stopRun,
        get store(){return store}, get dataset(){return dataset}, get ui(){return ui}
    }; })();`);
    vm.runInNewContext(instrumented, sandbox, { filename: 'boss_company_crawler.user.js' });
    function addCard({ displayName, jobId, companyId, area = '金华·义乌市·稠城' }) {
        const card = node(`${displayName} ${area}`);
        const job = node(); job.href = `https://www.zhipin.com/job_detail/${jobId}.html`;
        const company = node(displayName); company.href = `https://www.zhipin.com/gongsi/${companyId}.html`;
        const locationNode = node(area);
        card.querySelector = selector => selector.includes('/job_detail/') ? job
            : selector.includes('/gongsi/') ? company
            : selector.includes('.job-area') ? locationNode : null;
        cards.push(card); companyLinks.push(company);
        return card;
    }
    return {
        api: sandbox.api, sandbox, document, location, saved, timers, navigations, downloads, addCard,
        set failStorage(value) { failStorage = value; },
        advance(ms) { currentTime += ms; },
        fireDelay(delay) {
            const found = [...timers].find(([, timer]) => delay == null || timer.delay === delay);
            assert.ok(found, `expected timer ${delay ?? ''}`); timers.delete(found[0]); found[1].fn();
        }
    };
}

test('extracts the工商 company name from the actual label structure', () => {
    const h = harness({ businessText: '工商信息 公司名称 金华鸿鹄网络信息有限公司 法定代表人 夏秀峰 成立日期 2019-05-05' });
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.extractBusiness(h.document))), {
        hasSection: true, legalName: '金华鸿鹄网络信息有限公司'
    });
});

test('does not mistake the display brand for a legal name when工商 section is absent', () => {
    const h = harness({ businessText: '公司基本信息 鸿鹄 不需要融资 20-99人' });
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.extractBusiness(h.document))), { hasSection: false, legalName: '' });
});

test('scans visible job and company links and applies optional area filter', () => {
    const h = harness();
    h.addCard({ displayName: '义乌简称', jobId: 'job1', companyId: 'co1' });
    h.addCard({ displayName: '婺城简称', jobId: 'job2', companyId: 'co2', area: '金华·婺城区·西关' });
    h.api.ui.area.value = '义乌市';
    h.api.scanList();
    assert.equal(h.api.dataset.records.length, 1);
    assert.equal(h.api.dataset.records[0].displayName, '义乌简称');
    assert.equal(h.api.dataset.records[0].status, 'pending');
    assert.match(h.api.dataset.records[0].detailUrl, /job1\.html$/);
});

test('deduplicates by company profile URL even when two jobs exist', () => {
    const h = harness();
    h.addCard({ displayName: '同一公司', jobId: 'job1', companyId: 'same' });
    h.addCard({ displayName: '同一公司', jobId: 'job2', companyId: 'same' });
    h.api.scanList();
    assert.equal(h.api.dataset.records.length, 1);
});

test('upgrades a v1.2 display-only record when the company appears again', () => {
    const saved = { boss_company_crawler_v2: JSON.stringify({ version: 2, datasets: {
        '/web/geek/jobs?city=101210900&query=%E5%A4%96%E8%B4%B8%E4%B8%9A%E5%8A%A1%E5%91%98': {
            label: '旧搜索', companies: [{ name: '鸿鹄', source: '页面' }]
        }
    } }) };
    const h = harness({ saved });
    h.addCard({ displayName: '鸿鹄', jobId: 'job1', companyId: 'co1' });
    h.api.scanList();
    assert.equal(h.api.dataset.records.length, 1);
    assert.equal(h.api.dataset.records[0].status, 'pending');
    assert.match(h.api.dataset.records[0].companyUrl, /co1\.html$/);
});

test('starts a bounded detail run and navigates to one queued job', () => {
    const h = harness();
    h.addCard({ displayName: '公司甲', jobId: 'job1', companyId: 'co1' });
    h.api.ui.limit.value = '1';
    h.api.startBusinessRun();
    assert.equal(h.api.getRun().active, true);
    assert.equal(h.api.getRun().limit, 1);
    assert.equal(h.api.dataset.records[0].status, 'visiting');
    h.fireDelay(800);
    assert.match(h.navigations[0], /job1\.html$/);
});

test('detail page saves the legal name and finishes the run', () => {
    const datasetKey = '/web/geek/jobs?city=101210900&query=%E5%A4%96%E8%B4%B8%E4%B8%9A%E5%8A%A1%E5%91%98';
    const record = { displayName: '鸿鹄', companyUrl: 'https://www.zhipin.com/gongsi/co1.html',
        detailUrl: 'https://www.zhipin.com/job_detail/job1.html', status: 'visiting' };
    const saved = {
        boss_company_crawler_v2: JSON.stringify({ version: 3, datasets: { [datasetKey]: { label: '外贸', records: [record] } } }),
        boss_company_crawler_detail_run_v1: JSON.stringify({ active: true, datasetKey, returnUrl: 'https://www.zhipin.com/web/geek/jobs', limit: 1, processed: 0,
            currentKey: 'https://www.zhipin.com/gongsi/co1.html', startedAt: 'run-1' })
    };
    const h = harness({ url: 'https://www.zhipin.com/job_detail/job1.html', saved,
        businessText: '工商信息 公司名称 金华鸿鹄网络信息有限公司 法定代表人 夏秀峰' });
    const stored = JSON.parse(saved.boss_company_crawler_v2);
    assert.equal(stored.datasets[datasetKey].records[0].legalName, '金华鸿鹄网络信息有限公司');
    assert.equal(stored.datasets[datasetKey].records[0].status, 'done');
    assert.equal(h.api.getRun().active, false);
    h.fireDelay(1200);
    assert.equal(h.navigations[0], 'https://www.zhipin.com/web/geek/jobs');
});

test('pause preserves queued records and disables navigation', () => {
    const h = harness();
    h.addCard({ displayName: '公司甲', jobId: 'job1', companyId: 'co1' });
    h.api.startBusinessRun();
    h.api.stopRun();
    assert.equal(h.api.getRun().active, false);
    assert.equal(h.api.dataset.records.length, 1);
    assert.equal(h.timers.size, 0);
});

test('visible security verification is detected without treating ordinary safety copy as a block', () => {
    const h = harness({ businessText: 'BOSS安全提示：请勿进行违法违规招聘行为' });
    assert.equal(h.api.securityBlocked(h.document), false);
    h.document.securityNodes.push(node('请完成安全验证'));
    assert.equal(h.api.securityBlocked(h.document), true);
});

test('retry failed and no-info records without touching completed rows', () => {
    const h = harness();
    h.addCard({ displayName: '公司甲', jobId: 'job1', companyId: 'co1' });
    h.api.scanList();
    h.api.dataset.records[0].status = 'no_info';
    h.api.dataset.records.push(h.api.normalizeRecord({ displayName: '成功公司', legalName: '成功有限公司', status: 'done' }));
    h.api.retryFailed();
    assert.equal(h.api.dataset.records[0].status, 'pending');
    assert.equal(h.api.dataset.records[1].status, 'done');
});

test('storage failure does not erase in-memory scanned tasks', () => {
    const h = harness();
    h.addCard({ displayName: '公司甲', jobId: 'job1', companyId: 'co1' });
    h.failStorage = true;
    h.api.scanList();
    assert.equal(h.api.dataset.records.length, 1);
    assert.match(h.api.ui.status.textContent, /保存失败/);
});

test('CSV includes both display and legal names and neutralizes formulas', () => {
    const h = harness();
    const csv = h.api.buildCSV([h.api.normalizeRecord({ displayName: '鸿鹄', legalName: '金华鸿鹄网络信息有限公司', status: 'done' })]);
    assert.ok(csv.startsWith('\uFEFF'));
    assert.match(csv, /列表公司名.*工商公司名称/);
    assert.match(csv, /金华鸿鹄网络信息有限公司/);
    assert.equal(h.api.csvCell(' =SUM(1)'), '"\' =SUM(1)"');
});

test('does not use background fetch or the removed private API', () => {
    assert.ok(!source.includes('/wapi/'));
    assert.ok(!source.includes('fetch('));
    assert.match(source, /location\.assign\(record\.detailUrl\)/);
});
