// ==UserScript==
// @name         Boss直聘-公司名批量导出
// @namespace    boss-zhipin-company-crawler
// @version      1.2.0
// @description  采集职位页面已加载的公司名称，支持自动下滚、暂停、去重与CSV导出；不调用旧接口，不保证工商全称
// @author       Mavis
// @homepageURL  https://github.com/wuy705464-ai/boss-company-crawler
// @downloadURL  https://raw.githubusercontent.com/wuy705464-ai/boss-company-crawler/main/boss_company_crawler.user.js
// @updateURL    https://raw.githubusercontent.com/wuy705464-ai/boss-company-crawler/main/boss_company_crawler.user.js
// @match        https://www.zhipin.com/web/geek/job*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';
    if (document.getElementById('bp-panel')) return;

    const STORAGE_KEY = 'boss_company_crawler_v2';
    const LEGACY_KEY = 'boss_company_crawler_v1';
    const IDLE_TIMEOUT = 45000;
    const SCROLL_DELAY = 5000;
    const MAX_PAGE = 500;
    const cleanName = value => typeof value === 'string'
        ? value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim() : '';
    const validName = value => !!value && !/(?:\.{3,}|…+|⋯+)\s*$/.test(value);
    const errorText = e => String(e && e.message || e).slice(0, 160);
    const parseStored = value => typeof value === 'string' ? JSON.parse(value) : value;

    function searchContext() {
        const current = new URL(location.href);
        const params = new URLSearchParams(current.search);
        // 页面分页不改变采集任务。其余网址参数完整保留，避免丢失筛选条件。
        params.delete('page');
        params.delete('pageSize');
        params.sort();
        const query = params.get('query') || params.get('keyword') || '';
        const city = params.get('city') || '';
        return {
            key: params.toString(), params,
            label: [query, city ? `城市 ${city}` : ''].filter(Boolean).join(' · ') || '当前页面（地区与关键词以网站选择为准）',
            url: `${current.origin}${current.pathname}?${params}`
        };
    }

    function freshDataset(context) {
        return { label: context.label, url: context.url, companies: [], pagesDone: 0,
            fingerprints: [], completed: false, lastUpdated: null };
    }

    function normalizeItems(items) {
        const result = new Map();
        for (const item of Array.isArray(items) ? items : []) {
            const name = cleanName(item && item.name);
            if (!validName(name) || result.has(name)) continue;
            result.set(name, { name, source: typeof item.source === 'string' ? item.source : '历史',
                searchUrl: typeof item.searchUrl === 'string' ? item.searchUrl : '',
                collectedAt: typeof item.collectedAt === 'string' ? item.collectedAt : '' });
        }
        return [...result.values()];
    }

    let store = { version: 2, datasets: {} };
    let storageIssue = '';
    let legacyItems = [];
    try {
        const saved = parseStored(GM_getValue(STORAGE_KEY, '{}'));
        if (saved && saved.version === 2 && saved.datasets && typeof saved.datasets === 'object'
            && !Array.isArray(saved.datasets)) store = saved;
    } catch (e) { storageIssue = `读取保存数据失败：${errorText(e)}。请先导出备份再处理。`; }
    try {
        const legacy = parseStored(GM_getValue(LEGACY_KEY, '{}'));
        legacyItems = normalizeItems(legacy && legacy.companies);
    } catch (e) { console.warn('[Boss公司采集] 旧版数据读取失败', errorText(e)); }

    let context = searchContext();
    let state;
    let names;
    let activeRun = null;
    let message = '页面采集模式：先在 Boss 选择地区和关键词，等公司卡片出现后开始。';
    let messageType = '';
    let collapsed = false;

    function selectDataset() {
        const saved = Object.hasOwn(store.datasets, context.key) ? store.datasets[context.key] : null;
        state = { ...freshDataset(context), ...(saved && typeof saved === 'object' ? saved : {}) };
        state.companies = normalizeItems(state.companies);
        state.pagesDone = Number.isInteger(state.pagesDone) && state.pagesDone >= 0
            ? Math.min(state.pagesDone, MAX_PAGE) : 0;
        state.fingerprints = Array.isArray(state.fingerprints)
            ? state.fingerprints.filter(x => typeof x === 'string').slice(-MAX_PAGE) : [];
        state.completed = state.completed === true;
        state.label = context.label;
        state.url = context.url;
        names = new Set(state.companies.map(item => item.name));
        Object.defineProperty(store.datasets, context.key,
            { value: state, writable: true, enumerable: true, configurable: true });
    }

    function saveState() {
        if (storageIssue) throw new Error(storageIssue);
        state.lastUpdated = new Date().toISOString();
        // 只保存业务数据；运行状态、请求、计时器永不恢复。
        try { GM_setValue(STORAGE_KEY, JSON.stringify(store)); }
        catch (e) { throw new Error(`保存失败，已暂停；当前内存数据仍可导出：${errorText(e)}`); }
    }

    function mergeItems(items, source) {
        let added = 0;
        for (const item of items) {
            const name = cleanName(item.name);
            if (!validName(name) || names.has(name)) continue;
            names.add(name);
            state.companies.push({ name, source, searchUrl: context.url,
                collectedAt: new Date().toISOString() });
            added++;
        }
        return added;
    }


    const CARD_SELECTOR = '.job-card-wrapper, .job-card-box, .job-card-wrap, .job-card';
    const NAME_SELECTOR = '.company-name, .company-title, .company-info .company-text';

    function visible(element) {
        if (!element || !element.getClientRects().length || element.closest('[hidden], [aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function readPage() {
        const cards = [...document.querySelectorAll(CARD_SELECTOR)].filter(visible);
        const candidates = new Set();
        for (const card of cards) {
            for (const element of card.querySelectorAll(NAME_SELECTOR)) candidates.add(element);
            for (const link of card.querySelectorAll('a[href*="/gongsi/"]')) {
                const label = link.querySelector(NAME_SELECTOR);
                if (label) candidates.add(label);
                else if (!link.querySelector('.company-tag-list, .company-tag, .company-info, p')) candidates.add(link);
            }
        }
        // 卡片外壳变化时仍可识别明确的公司名节点，不使用招聘者姓名。
        for (const element of document.querySelectorAll('.company-name')) {
            if (!element.closest('#bp-panel')) candidates.add(element);
        }
        const items = [];
        for (const element of candidates) {
            if (!visible(element)) continue;
            const link = element.querySelector('a') || element;
            const name = [link.getAttribute('title'), element.getAttribute('title'), link.textContent]
                .map(cleanName).find(validName);
            if (name) items.push({ name });
        }
        const identities = cards.map(card => {
            const link = card.querySelector('a[href*="/job_detail/"]');
            return link ? link.getAttribute('href').split('?')[0] : cleanName(card.textContent);
        });
        return { items: normalizeItems(items), cards,
            signature: JSON.stringify([identities.sort(), items.map(item => item.name).sort()]) };
    }

    function blockingNotice() {
        for (const element of document.querySelectorAll('[role="dialog"], .verify-dialog, .verify-wrap, .captcha-box, .login-dialog')) {
            if (visible(element) && /验证|验证码|登录|操作频繁|访问异常/.test(element.textContent)) return true;
        }
        return false;
    }

    function scrollResults(cards) {
        if (!cards.length) return;
        let parent = cards[cards.length - 1].parentElement;
        while (parent && parent !== document.body && parent !== document.documentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 8) {
                parent.scrollBy({ top: Math.max(200, parent.clientHeight * 0.8), behavior: 'smooth' });
                return;
            }
            parent = parent.parentElement;
        }
        window.scrollBy({ top: Math.max(200, window.innerHeight * 0.8), behavior: 'smooth' });
    }

    function stopRun(text = '已暂停，已采集的公司保留，可导出或继续。', type = '') {
        const run = activeRun;
        activeRun = null;
        if (run) clearInterval(run.timer);
        setStatus(text, type);
    }

    function syncContext() {
        const next = searchContext();
        if (next.key === context.key) return false;
        stopRun(); context = next; selectDataset();
        setStatus('网址搜索条件已改变，已暂停并切换对应数据。等页面结果加载后再开始。');
        return true;
    }

    function tick(run) {
        if (activeRun !== run || syncContext()) return;
        try {
            if (blockingNotice()) return stopRun('检测到登录或验证提示，已暂停。请在网站正常处理后继续。', 'error');
            const page = readPage();
            const added = mergeItems(page.items, '页面');
            if (added || run.needsSave) { saveState(); run.needsSave = false; }
            const now = Date.now();
            if (page.items.length && page.signature !== run.signature) {
                run.signature = page.signature;
                run.lastChange = now;
            }
            if (now - run.lastChange >= IDLE_TIMEOUT) {
                return stopRun(page.items.length ? '45 秒没有出现新职位，已暂停。可手动翻页后继续；不代表已采集全部。'
                    : '没有读到公司卡片，已暂停。请先搜索并等待职位列表加载。', 'error');
            }
            setStatus(page.items.length ? '采集中：页面读到 ' + page.items.length + ' 家，本轮新增 ' + added + ' 家，累计 ' + state.companies.length + ' 家。'
                : '等待公司卡片加载…请在网站搜索或滚动到职位列表。', added ? 'success' : '');
            if (ui.autoscroll.checked && now - run.lastScroll >= SCROLL_DELAY) {
                scrollResults(page.cards); run.lastScroll = now;
            }
        } catch (e) { stopRun(errorText(e), 'error'); }
    }

    function startRun() {
        if (activeRun) return;
        syncContext();
        if (storageIssue) return setStatus(storageIssue, 'error');
        const run = { signature: '', lastChange: Date.now(), lastScroll: Date.now(), needsSave: true };
        activeRun = run;
        tick(run);
        if (activeRun === run) run.timer = setInterval(() => tick(run), 1000);
    }

    function collectCurrentPage() {
        stopRun();
        if (syncContext()) return;
        if (storageIssue) return setStatus(storageIssue, 'error');
        try {
            if (blockingNotice()) return setStatus('请先在网站正常处理登录或验证。', 'error');
            const { items } = readPage();
            if (!items.length) return setStatus('没有找到公司卡片，请先在网站搜索并等待列表加载。', 'error');
            const added = mergeItems(items, '页面');
            saveState();
            setStatus('当前页面读到 ' + items.length + ' 家，新增 ' + added + ' 家，累计 ' + state.companies.length + ' 家。', 'success');
        } catch (e) { setStatus(errorText(e), 'error'); }
    }

    function allHistory() {
        return normalizeItems([...Object.values(store.datasets).flatMap(data => Array.isArray(data && data.companies) ? data.companies : []), ...legacyItems]);
    }

    function csvCell(value) {
        let text = String(value == null ? '' : value);
        if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
    }

    function buildCSV(items) {
        const rows = [['公司名称（未工商核验）', '采集来源', '搜索页面', '首次采集时间']];
        for (const item of items) rows.push([item.name, item.source, item.searchUrl, item.collectedAt]);
        return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    }

    function exportCSV(items = state.companies, label = context.label) {
        if (!items.length) return setStatus('还没有数据可导出。', 'error');
        const url = URL.createObjectURL(new Blob([buildCSV(items)], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        const now = new Date();
        const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        a.href = url;
        a.download = `boss_company_${label.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80)}_${date}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setStatus(`已导出 ${items.length} 家公司。`, 'success');
    }

    function resetProgress(clear) {
        if (syncContext()) return;
        if (clear && !confirm('确认清空当前搜索的公司和进度？其他搜索及旧版数据不受影响。')) return;
        stopRun();
        const previousItems = state.companies;
        if (clear) state.companies = [];
        state.pagesDone = 0;
        state.fingerprints = [];
        state.completed = false;
        try {
            saveState();
            if (clear) names.clear();
            setStatus('当前搜索的数据已清空。');
        } catch (e) { state.companies = previousItems; setStatus(errorText(e), 'error'); }
    }

    GM_addStyle(`
        #bp-panel{position:fixed;top:80px;right:20px;width:320px;max-width:calc(100vw - 40px);box-sizing:border-box;
            background:#fff;border:2px solid #00a980;border-radius:8px;padding:14px;z-index:999999;
            font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#333;box-shadow:0 6px 20px #0003}
        #bp-panel *{box-sizing:border-box} #bp-panel [hidden]{display:none!important}
        #bp-panel .bp-title{display:flex;align-items:center;justify-content:space-between;font-weight:bold;color:#00876a;font-size:15px}
        #bp-panel .bp-row{margin:6px 0;overflow-wrap:anywhere} #bp-panel b{color:#00876a}
        #bp-panel .bp-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
        #bp-panel button{background:#fff;color:#00876a;border:1px solid #00a980;padding:5px 9px;border-radius:4px;cursor:pointer;font:inherit}
        #bp-panel button:disabled{opacity:.45;cursor:default} #bp-panel .bp-primary{background:#00876a;color:#fff}
        #bp-panel input{width:auto;padding:3px;border:1px solid #bbb;color:#333;background:#fff;font:inherit}
        #bp-panel .bp-note{font-size:12px;color:#666;margin-top:8px}
        #bp-panel .bp-status{margin-top:8px;padding:6px 8px;background:#f5f5f5;border-radius:4px;font-size:12px;overflow-wrap:anywhere}
        #bp-panel .bp-status.error{background:#fff0f0;color:#b22} #bp-panel .bp-status.success{background:#eef9f4;color:#087153}
    `);
    const panel = document.createElement('div');
    panel.id = 'bp-panel';
    // 此模板只有静态标记；公司名、搜索参数和接口消息一律通过 textContent 写入。
    panel.innerHTML = `
        <div class="bp-title">🏢 Boss 公司采集 v1.2.0 <button id="bp-collapse" aria-label="折叠采集面板" aria-expanded="true">收起</button></div>
        <div id="bp-body">
            <div class="bp-row" id="bp-target"></div>
            <div class="bp-row">页面采集 · 去重公司：<b id="bp-count">0</b> 家</div>
            <label><input id="bp-autoscroll" type="checkbox" checked>自动向下滚动加载结果</label>
            <div class="bp-btns">
                <button class="bp-primary" id="bp-start">开始采集</button>
                <button id="bp-dom">采集当前页</button><button id="bp-export">导出 CSV</button>
                <button id="bp-history">导出全部历史</button><button id="bp-clear">清空当前搜索</button>
                <button id="bp-legacy" hidden>导出旧版数据</button>
            </div>
            <div class="bp-note">地区和关键词以 Boss 页面选择为准。只收集已加载的公司卡片，不调用旧接口。需要时请手动翻页；名称不保证工商全称。网址不变的筛选结果会合并保存。</div>
            <div class="bp-status" id="bp-status" role="status" aria-live="polite"></div>
        </div>`;
    document.body.appendChild(panel);
    const ui = {};
    for (const id of ['body', 'target', 'count', 'autoscroll', 'start', 'dom', 'export', 'history', 'clear', 'legacy', 'status', 'collapse']) {
        ui[id] = panel.querySelector(`#bp-${id}`);
    }

    function updatePanel() {
        ui.target.textContent = `当前搜索：${context.label}`;
        ui.target.title = context.url;
        ui.count.textContent = String(state.companies.length);
        ui.start.textContent = activeRun ? '暂停' : '开始采集';
        ui.legacy.hidden = !legacyItems.length;
        ui.status.textContent = message;
        ui.status.className = `bp-status ${messageType}`;
    }
    function setStatus(text, type = '') { message = text; messageType = type; updatePanel(); }
    ui.start.onclick = () => activeRun ? stopRun() : startRun();
    ui.dom.onclick = collectCurrentPage;
    ui.export.onclick = () => { if (!syncContext()) exportCSV(); };
    ui.legacy.onclick = () => exportCSV(legacyItems, '旧版历史_来源条件未核验');
    ui.history.onclick = () => exportCSV(allHistory(), '全部历史');
    ui.clear.onclick = () => resetProgress(true);
    ui.collapse.onclick = () => {
        collapsed = !collapsed;
        ui.body.hidden = collapsed;
        ui.collapse.textContent = collapsed ? '展开' : '收起';
        ui.collapse.setAttribute('aria-expanded', String(!collapsed));
    };
    selectDataset();
    if (storageIssue) { message = storageIssue; messageType = 'error'; }
    else if (legacyItems.length) message = '旧版数据已保留，可单独导出；旧版页码不沿用，以免继承重复页进度。';
    updatePanel();
    // 搜索/筛选操作时先暂停，避免过渡页面混入结果。
    function pauseForFilter(event) {
        if (!activeRun || !event.target.closest || event.target.closest('#bp-panel')) return;
        if (event.type === 'change' || event.target.closest('.search-box, .job-search-box, .search-filter, .filter-box, .filter-select-box, .city-select, .expect-item')) {
            stopRun('检测到页面筛选操作，已暂停。等结果加载后再继续。');
        }
    }
    document.addEventListener('change', pauseForFilter, true);
    document.addEventListener('click', pauseForFilter, true);
    // SPA 搜索切换不一定刷新页面。
    setInterval(syncContext, 1000);
    window.addEventListener('pagehide', () => stopRun());
})();
