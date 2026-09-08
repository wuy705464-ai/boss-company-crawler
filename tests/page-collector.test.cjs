const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../boss_company_crawler.user.js'), 'utf8');
function element(text = '') {
    return { textContent: text, checked: true, children: {}, style: {}, hidden: false,
        set innerHTML(html) { for (const m of html.matchAll(/id="([^"]+)"/g)) this.children[m[1]] = element(); },
        querySelector(s) { return this.children[s.slice(1)] || null; }, querySelectorAll() { return []; },
        getAttribute(name) { return this[name] || null; }, setAttribute() {},
        getClientRects() { return this.hidden ? [] : [{}]; }, closest() { return null; },
        appendChild() {}, remove() {}, click() {} };
}
function harness(saved = {}) {
    let now = 100000, failWrite = false, scrolls = 0, nextTimer = 0;
    const timers = new Map(), writes = [], listeners = {};
    const document = { nodes: [], cards: [], dialogs: [], body: element(), documentElement: element(),
        getElementById() { return null; }, createElement: element,
        addEventListener(name, fn) { listeners[name] = fn; },
        querySelectorAll(s) {
            if (s.includes('.job-card-wrapper')) return this.cards;
            if (s === '.company-name') return this.nodes;
            if (s.includes('[role="dialog"]')) return this.dialogs;
            return [];
        } };
    const sandbox = { document, location: {href:'https://www.zhipin.com/web/geek/jobs'}, URL, URLSearchParams, Blob, console,
        Date: class extends Date { static now() { return now; } },
        getComputedStyle: el => ({display:'block',visibility:'visible',overflowY:'visible', ...el.style}),
        GM_addStyle() {}, GM_getValue: (key, fallback) => saved[key] ?? fallback,
        GM_setValue: (key, value) => { if (failWrite) throw new Error('quota exceeded'); saved[key] = value; writes.push(value); },
        setTimeout() {}, clearTimeout() {},
        setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, {fn, ms}); return id; },
        clearInterval: id => timers.delete(id), confirm: () => true,
        window: {innerHeight:800, scrollBy() { scrolls++; }, addEventListener() {}},
        fetch() { throw new Error('Page collector must never call an API'); }
    };
    vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `globalThis.api = {readPage, startRun, stopRun, tick, syncContext, collectCurrentPage, resetProgress, allHistory, buildCSV, csvCell,
        get state(){return state}, get activeRun(){return activeRun}, get ui(){return ui} }; })();`), sandbox);
    return { api:sandbox.api, sandbox, document, writes, timers, listeners, saved,
        set failWrite(x) {failWrite=x;}, get scrolls(){return scrolls;},
        advance(ms) {now += ms; if(sandbox.api.activeRun) sandbox.api.tick(sandbox.api.activeRun);},
        addCompany(name, id = name) {
            const label = element(name); const card = element('职位 ' + id + ' ' + name);
            const jobLink = element(); jobLink.href = '/job_detail/' + id + '.html';
            card.querySelector = s => s.includes('/job_detail/') ? jobLink : null;
            card.querySelectorAll = s => s.includes('.company-name') ? [label] : [];
            card.parentElement = document.body;
            document.nodes.push(label); document.cards.push(card); return label;
        }
    };
}

test('new /jobs route without query uses page mode and never sends requests', () => {
    const h=harness(); h.addCompany('测试甲'); h.api.startRun();
    assert.equal(h.api.state.companies.length,1);
    assert.match(h.api.ui.target.textContent,/以网站选择为准/);
    assert.ok(!source.includes('/wapi/'));
    assert.ok(!source.includes('fetch('));
});
test('reads parent title, ignores hidden names and literal truncation',()=>{
    const h=harness(); h.addCompany('简称…').title='标题公司';
    h.addCompany('隐藏公司').hidden=true; h.addCompany('缺失全名...');
    assert.deepEqual(Array.from(h.api.readPage().items,x=>x.name),['标题公司']);
});
test('current page collection deduplicates names and keeps legacy page counters untouched',()=>{
    const h=harness(); h.addCompany(' 公司甲 '); h.addCompany('公司甲');
    h.api.collectCurrentPage(); h.api.collectCurrentPage();
    assert.equal(h.api.state.companies.length,1); assert.equal(h.api.state.pagesDone,0);
});
test('continues collecting newly rendered cards',()=>{
    const h=harness(); h.addCompany('公司甲'); h.api.startRun(); h.addCompany('公司乙'); h.advance(1000);
    assert.equal(h.api.state.companies.length,2);
});
test('pause/restart leaves one active collection timer; stale tick does nothing',()=>{
    const h=harness(); h.addCompany('公司甲'); h.api.startRun(); const old=h.api.activeRun;
    h.api.startRun(); h.api.stopRun(); h.addCompany('公司乙'); h.api.tick(old);
    assert.equal(h.api.state.companies.length,1);
    h.api.startRun(); assert.equal(h.api.state.companies.length,2); assert.equal(h.timers.size,2);
});
test('clear stops collection; stale callback cannot restore data',()=>{
    const h=harness(); h.addCompany('公司甲'); h.api.startRun(); const old=h.api.activeRun;
    h.api.resetProgress(true); h.api.tick(old);
    assert.equal(h.api.state.companies.length,0); assert.equal(h.api.activeRun,null);
});
test('storage failure keeps exportable names and can persist on retry without new names',()=>{
    const h=harness(); h.addCompany('公司甲'); h.failWrite=true; h.api.startRun();
    assert.equal(h.api.activeRun,null); assert.match(h.api.ui.status.textContent,/保存失败/);
    assert.match(h.api.buildCSV(h.api.state.companies),/公司甲/);
    h.failWrite=false; h.api.startRun(); assert.ok(h.writes.length>0);
});
test('failed clear restores in-memory data',()=>{
    const h=harness(); h.addCompany('公司甲'); h.api.collectCurrentPage(); h.failWrite=true; h.api.resetProgress(true);
    assert.equal(h.api.state.companies.length,1);
});
test('changed URL stops before collecting the old DOM under a new query',()=>{
    const h=harness(); h.addCompany('公司甲'); h.api.startRun(); h.sandbox.location.href+='?query=other'; h.advance(1000);
    assert.equal(h.api.activeRun,null); assert.equal(h.api.state.companies.length,0);
    assert.equal(h.api.allHistory().length,1);
});
test('manual pagination URL keeps the same dataset',()=>{
    const h=harness(); h.addCompany('公司甲'); h.api.startRun(); h.sandbox.location.href+='?page=2'; h.addCompany('公司乙'); h.advance(1000);
    assert.ok(h.api.activeRun); assert.equal(h.api.state.companies.length,2);
});
test('visible verification dialog pauses without collecting or scrolling',()=>{
    const h=harness(); h.document.dialogs.push(element('请完成验证')); h.addCompany('公司甲'); h.api.startRun();
    assert.equal(h.api.activeRun,null); assert.equal(h.api.state.companies.length,0); assert.equal(h.scrolls,0);
});
test('stalled list stops after 45 seconds and does not claim completeness',()=>{
    const h=harness(); h.addCompany('公司甲'); h.api.startRun(); h.advance(45000);
    assert.equal(h.api.activeRun,null); assert.match(h.api.ui.status.textContent,/不代表已采集全部/);
});
test('same company on a new job resets the idle timer',()=>{
    const h=harness(); h.addCompany('公司甲','job1'); h.api.startRun(); h.advance(40000);
    h.addCompany('公司甲','job2'); h.advance(5000); assert.ok(h.api.activeRun);
    assert.equal(h.api.state.companies.length,1);
});
test('autoscroll uses 5-second cadence and can be disabled',()=>{
    const h=harness(); h.addCompany('公司甲'); h.api.startRun(); h.advance(4999); assert.equal(h.scrolls,0);
    h.advance(1); assert.equal(h.scrolls,1); h.api.ui.autoscroll.checked=false; h.advance(5000); assert.equal(h.scrolls,1);
});
test('empty list waits for loading, then pauses without scrolling',()=>{
    const h=harness(); h.api.startRun(); h.advance(5000); assert.ok(h.api.activeRun); assert.equal(h.scrolls,0);
    h.advance(40000); assert.equal(h.api.activeRun,null); assert.match(h.api.ui.status.textContent,/没有读到公司卡片/);
});
test('history export includes v1 and v2 records without restoring running state',()=>{
    const h=harness({boss_company_crawler_v1:JSON.stringify({companies:[{name:'老公司'}],running:true}),
        boss_company_crawler_v2:JSON.stringify({version:2,datasets:{old:{companies:[{name:'二版公司'}],pagesDone:99}}})});
    assert.equal(h.api.allHistory().length,2); assert.equal(h.api.activeRun,null);
});
test('CSV keeps BOM, quotes fields and neutralizes formulas',()=>{
    const h=harness(); assert.ok(h.api.buildCSV([{name:'公司'}]).startsWith('\uFEFF'));
    assert.equal(h.api.csvCell(' =SUM(1)'), '"\' =SUM(1)"');
    assert.equal(h.api.csvCell('a,"b"\nc'),'"a,""b""\nc"');
});
test('filter change pauses; panel checkbox does not pause',()=>{
    const h=harness(); h.addCompany('公司甲'); h.api.startRun();
    h.listeners.change({type:'change',target:{closest:s=>s==='#bp-panel'?{}:null}}); assert.ok(h.api.activeRun);
    h.listeners.change({type:'change',target:{closest:()=>null}}); assert.equal(h.api.activeRun,null);
});
