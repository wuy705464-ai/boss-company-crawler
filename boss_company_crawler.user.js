// ==UserScript==
// @name         Boss直聘-公司名批量导出
// @namespace    boss-zhipin-company-crawler
// @version      1.1.1
// @description  按当前网址的搜索条件采集公司显示名称，支持暂停续采、当前页采集、去重和 CSV 导出；不保证工商全称
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
    const PAGE_SIZE = 30;
    const REQUEST_TIMEOUT = 20000;
    const PAGE_DELAY = [4000, 7000];
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
        const query = params.get('query') || params.get('keyword') || '未指定关键词';
        const city = params.get('city') || '未指定城市（网站默认）';
        return {
            key: params.toString(), params,
            label: `${query} · 城市 ${city}`,
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
    let message = '就绪。先确认页面筛选条件；自动采集从第 1 页开始。';
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

    function saveCheckpoint(page, fingerprint, completed) {
        const previousPage = state.pagesDone;
        const previousCompleted = state.completed;
        const previousLength = state.fingerprints.length;
        state.pagesDone = page;
        state.completed = completed;
        if (fingerprint) state.fingerprints.push(fingerprint);
        try { saveState(); }
        catch (e) {
            // 保存失败保留已读名称供导出，但回滚页码，恢复后重读本页。
            state.pagesDone = previousPage;
            state.completed = previousCompleted;
            state.fingerprints.length = previousLength;
            throw e;
        }
    }

    function domItems() {
        const items = [];
        const cards = document.querySelectorAll('.job-card-wrapper, .job-card-box');
        for (const card of cards) {
            const parent = card.querySelector('.company-name');
            const link = parent && (parent.querySelector('a') || parent);
            if (!link) continue;
            const candidates = [link.getAttribute('title'), parent.getAttribute('title'), link.textContent];
            const name = candidates.map(cleanName).find(validName);
            if (name) items.push({ name });
        }
        return items;
    }

    function parsePage(json) {
        if (!json || json.code !== 0) {
            throw new Error(`接口未成功（${json && json.code != null ? json.code : '未知状态'}）：${errorText(json && json.message || '请检查登录或验证页面')}`);
        }
        const data = json.zpData;
        if (!data || !Array.isArray(data.jobList)) throw new Error('接口结构变化：缺少 jobList，未推进页码');
        const jobs = data.jobList;
        const items = jobs.map(job => {
            if (!job || typeof job !== 'object') return { name: '' };
            const name = [job.companyName, job.brandName].map(cleanName).find(validName) || '';
            return { name };
        }).filter(item => validName(item.name));
        if (jobs.length && !items.length) throw new Error('本页有职位但无法识别公司名称，未推进页码');
        // 用职位身份检测重复页，不能用公司名称：不同职位页可能属于同一批公司。
        const identities = jobs.map(job => job && (job.encryptJobId || job.jobId)
            ? `id:${job.encryptJobId || job.jobId}` : JSON.stringify(job));
        const fingerprint = JSON.stringify(identities.sort());
        const hasMore = data.hasMore === false || data.hasMore === 0 || data.hasMore === 'false' || data.hasMore === '0'
            ? false : data.hasMore === true || data.hasMore === 1 || data.hasMore === 'true' || data.hasMore === '1' ? true : null;
        return { items, fingerprint, count: jobs.length, hasMore };
    }

    async function fetchPage(page, run) {
        const params = new URLSearchParams(run.context.params);
        params.set('page', String(page));
        params.set('pageSize', String(PAGE_SIZE));
        const controller = new AbortController();
        run.controller = controller;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT);
        try {
            const response = await fetch(`/wapi/zpgeek/job/list.json?${params}`, {
                credentials: 'include', signal: controller.signal,
                headers: { accept: 'application/json, text/plain, */*' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}，请检查网站是否要求登录或验证`);
            let json;
            try { json = await response.json(); }
            catch (e) {
                if (controller.signal.aborted) throw e;
                throw new Error('返回内容不是 JSON，可能需要登录或验证');
            }
            return parsePage(json);
        } catch (e) {
            if (timedOut) throw new Error('请求超过 20 秒，已暂停，可稍后继续');
            throw e;
        } finally {
            clearTimeout(timer);
            if (run.controller === controller) run.controller = null;
        }
    }

    function delay(run) {
        return new Promise(resolve => {
            const timer = setTimeout(finish, PAGE_DELAY[0] + Math.random() * (PAGE_DELAY[1] - PAGE_DELAY[0]));
            function finish() { clearTimeout(timer); run.wake = null; resolve(); }
            run.wake = finish;
        });
    }

    function stopRun(text = '已暂停，已保存的页码可继续。') {
        const run = activeRun;
        activeRun = null; // 先使旧循环失效，保证迟到响应无法写回。
        if (run) {
            run.cancelled = true;
            if (run.controller) run.controller.abort();
            if (run.wake) run.wake();
        }
        setStatus(text);
    }

    function syncContext() {
        const next = searchContext();
        if (next.key === context.key) return false;
        stopRun();
        context = next;
        selectDataset();
        setStatus('搜索条件已改变，已切换到对应进度；请等待页面结果加载后再采集。');
        return true;
    }

    async function crawlLoop() {
        if (activeRun) return;
        syncContext();
        if (storageIssue) return setStatus(storageIssue, 'error');
        if (state.completed) return setStatus('该搜索已到末页。如需更新，点击“从头重扫”（保留已有公司）。');
        const limit = Number(ui.limit.value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) return setStatus('单次采集页数请填 1–100。', 'error');
        const run = { cancelled: false, context, controller: null, wake: null };
        activeRun = run;
        updatePanel();
        try {
            for (let done = 0; done < limit; done++) {
                if (activeRun !== run || run.cancelled || syncContext()) return;
                const page = state.pagesDone + 1;
                if (page > MAX_PAGE) { setStatus('已达 500 页上限，请缩小搜索范围。'); break; }
                setStatus(`正在读取第 ${page} 页…`);
                const result = await fetchPage(page, run);
                if (activeRun !== run || run.cancelled || syncContext()) return;
                if (result.count === 0) {
                    if (result.hasMore === true) throw new Error('接口返回空页却标记还有下一页，已停止，未推进页码');
                    saveCheckpoint(state.pagesDone, null, true);
                    setStatus(`已到末页，共 ${state.companies.length} 家公司。`, 'success');
                    break;
                }
                if (state.fingerprints.includes(result.fingerprint)) {
                    throw new Error('接口返回了已经采集过的职位页，已停止，未推进页码');
                }
                const added = mergeItems(result.items, 'API');
                saveCheckpoint(page, result.fingerprint, result.hasMore === false);
                setStatus(`第 ${page} 页新增 ${added} 家，累计 ${state.companies.length} 家。${state.completed ? '已到末页。' : done + 1 === limit ? '本轮完成，可继续。' : ''}`, 'success');
                if (state.completed || done + 1 === limit) break;
                await delay(run);
            }
        } catch (e) {
            if (activeRun === run && !run.cancelled) setStatus(`已停止：${errorText(e)}`, 'error');
        } finally {
            if (activeRun === run) { activeRun = null; updatePanel(); }
        }
    }

    function collectCurrentPage() {
        if (activeRun) return;
        if (syncContext()) return;
        try {
            const items = domItems();
            if (!items.length) return setStatus('没有找到可识别的公司名称；请确认职位卡片已加载，或网站布局已变化。', 'error');
            const added = mergeItems(items, 'DOM');
            saveState();
            setStatus(`当前页新增 ${added} 家（读到 ${items.length} 条）。手动采集不改变 API 页码。`, 'success');
        } catch (e) { setStatus(errorText(e), 'error'); }
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
        if (clear) { state.companies = []; names.clear(); }
        state.pagesDone = 0;
        state.fingerprints = [];
        state.completed = false;
        try {
            saveState();
            setStatus(clear ? '当前搜索的数据已清空。' : '已重置为第 1 页，已有公司保留，点击开始采集即可更新。');
        } catch (e) { setStatus(errorText(e), 'error'); }
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
        #bp-panel input{width:60px;padding:3px;border:1px solid #bbb;color:#333;background:#fff;font:inherit}
        #bp-panel .bp-note{font-size:12px;color:#666;margin-top:8px}
        #bp-panel .bp-status{margin-top:8px;padding:6px 8px;background:#f5f5f5;border-radius:4px;font-size:12px;overflow-wrap:anywhere}
        #bp-panel .bp-status.error{background:#fff0f0;color:#b22} #bp-panel .bp-status.success{background:#eef9f4;color:#087153}
    `);
    const panel = document.createElement('div');
    panel.id = 'bp-panel';
    // 此模板只有静态标记；公司名、搜索参数和接口消息一律通过 textContent 写入。
    panel.innerHTML = `
        <div class="bp-title">🏢 Boss 公司名采集 <button id="bp-collapse" aria-label="折叠采集面板" aria-expanded="true">收起</button></div>
        <div id="bp-body">
            <div class="bp-row" id="bp-target"></div>
            <div class="bp-row">去重公司：<b id="bp-count">0</b> 家 · API 已完成：<b id="bp-pages">0</b> 页</div>
            <label>单次最多 <input id="bp-limit" type="number" min="1" max="100" value="20"> 页</label>
            <div class="bp-btns">
                <button class="bp-primary" id="bp-start">开始 / 继续</button>
                <button id="bp-dom">采集当前页</button><button id="bp-export">导出 CSV</button>
                <button id="bp-restart">从头重扫</button><button id="bp-clear">清空当前搜索</button>
                <button id="bp-legacy" hidden>导出旧版数据</button>
            </div>
            <div class="bp-note">自动采集按当前网址参数运行。网址未体现的筛选请用“采集当前页”。名称来自页面或接口，不保证工商全称。接口受限会停止，请在网站正常完成登录或验证。</div>
            <div class="bp-status" id="bp-status" role="status" aria-live="polite"></div>
        </div>`;
    document.body.appendChild(panel);
    const ui = {};
    for (const id of ['body', 'target', 'count', 'pages', 'limit', 'start', 'dom', 'export', 'restart', 'clear', 'legacy', 'status', 'collapse']) {
        ui[id] = panel.querySelector(`#bp-${id}`);
    }

    function updatePanel() {
        ui.target.textContent = `当前搜索：${context.label}`;
        ui.target.title = context.url;
        ui.count.textContent = String(state.companies.length);
        ui.pages.textContent = String(state.pagesDone);
        ui.start.textContent = activeRun ? '暂停' : '开始 / 继续';
        ui.dom.disabled = !!activeRun;
        ui.limit.disabled = !!activeRun;
        ui.legacy.hidden = !legacyItems.length;
        ui.status.textContent = message;
        ui.status.className = `bp-status ${messageType}`;
    }
    function setStatus(text, type = '') { message = text; messageType = type; updatePanel(); }
    ui.start.onclick = () => activeRun ? stopRun() : void crawlLoop();
    ui.dom.onclick = collectCurrentPage;
    ui.export.onclick = () => { if (!syncContext()) exportCSV(); };
    ui.legacy.onclick = () => exportCSV(legacyItems, '旧版历史_来源条件未核验');
    ui.restart.onclick = () => resetProgress(false);
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
    // SPA 搜索切换不一定触发页面刷新；每次请求返回时也会同步检查。
    setInterval(syncContext, 1000);
    window.addEventListener('pagehide', () => stopRun());
})();
