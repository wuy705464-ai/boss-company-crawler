// ==UserScript==
// @name         Boss直聘-工商公司名采集
// @namespace    boss-zhipin-company-crawler
// @version      1.3.0
// @description  从职位列表建立任务，逐个进入职位详情页读取工商公司名称；支持断点续采、限速、去重和CSV导出
// @author       Mavis
// @homepageURL  https://github.com/wuy705464-ai/boss-company-crawler
// @downloadURL  https://raw.githubusercontent.com/wuy705464-ai/boss-company-crawler/main/boss_company_crawler.user.js
// @updateURL    https://raw.githubusercontent.com/wuy705464-ai/boss-company-crawler/main/boss_company_crawler.user.js
// @match        https://www.zhipin.com/web/geek/job*
// @match        https://www.zhipin.com/job_detail/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @grant        GM_addStyle
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';
    if (document.getElementById('bp-panel')) return;

    const STORAGE_KEY = 'boss_company_crawler_v2';
    const RUN_KEY = 'boss_company_crawler_detail_run_v1';
    const SETTINGS_KEY = 'boss_company_crawler_settings_v1';
    const LEGACY_KEY = 'boss_company_crawler_v1';
    const DETAIL_WAIT_MS = 20000;
    const PAGE_DELAY = [6000, 10000];
    const MAX_BATCH = 100;
    const clean = value => typeof value === 'string'
        ? value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim() : '';
    const validName = value => !!value && !/(?:\.{3,}|…+|⋯+)\s*$/.test(value);
    const errorText = error => clean(error && error.message || error).slice(0, 180);
    const parseStored = (value, fallback) => {
        try { return typeof value === 'string' ? JSON.parse(value) : value; }
        catch (_) { return fallback; }
    };
    const nowIso = () => new Date().toISOString();
    const canonicalUrl = value => {
        if (!clean(value)) return '';
        try {
            const url = new URL(value, location.origin);
            if (url.origin !== location.origin) return '';
            return url.origin + url.pathname;
        } catch (_) { return ''; }
    };

    function pageContext() {
        const url = new URL(location.href);
        const params = new URLSearchParams(url.search);
        params.delete('page');
        params.delete('pageSize');
        params.sort();
        const query = params.get('query') || params.get('keyword') || '';
        const city = params.get('city') || '';
        const key = url.pathname.startsWith('/job_detail/') ? '' : `${url.pathname}?${params}`;
        return {
            key,
            label: [query, city ? `城市 ${city}` : ''].filter(Boolean).join(' · ') || '当前职位列表',
            url: url.origin + (url.pathname.startsWith('/job_detail/') ? '/web/geek/jobs' : url.pathname) + (params.size ? '?' + params : '')
        };
    }

    function normalizeRecord(item) {
        const displayName = clean(item && (item.displayName || item.name));
        const legalName = clean(item && item.legalName);
        const detailUrl = canonicalUrl(item && item.detailUrl);
        const companyUrl = canonicalUrl(item && item.companyUrl);
        let status = clean(item && item.status);
        if (legalName) status = 'done';
        else if (!['pending', 'visiting', 'no_info', 'error', 'legacy'].includes(status)) status = detailUrl ? 'pending' : 'legacy';
        return {
            displayName,
            legalName,
            location: clean(item && item.location),
            detailUrl,
            companyUrl,
            status,
            attempts: Number.isInteger(item && item.attempts) ? Math.max(0, item.attempts) : 0,
            lastError: clean(item && item.lastError).slice(0, 180),
            searchUrl: clean(item && item.searchUrl),
            collectedAt: clean(item && item.collectedAt),
            enrichedAt: clean(item && item.enrichedAt)
        };
    }

    function recordKey(record) {
        return record.companyUrl || record.detailUrl || `name:${record.displayName}`;
    }

    function normalizeRecords(items) {
        const byKey = new Map();
        for (const source of Array.isArray(items) ? items : []) {
            const record = normalizeRecord(source);
            if (!record.displayName && !record.legalName) continue;
            const key = recordKey(record);
            const current = byKey.get(key);
            if (!current) { byKey.set(key, record); continue; }
            if (!current.legalName && record.legalName) Object.assign(current, record);
            else {
                current.detailUrl ||= record.detailUrl;
                current.companyUrl ||= record.companyUrl;
                current.location ||= record.location;
                current.searchUrl ||= record.searchUrl;
                current.collectedAt ||= record.collectedAt;
            }
        }
        return [...byKey.values()];
    }

    let storageIssue = '';
    let store = { version: 3, datasets: {} };
    const rawStore = parseStored(GM_getValue(STORAGE_KEY, '{}'), null);
    if (!rawStore) storageIssue = '历史数据格式损坏，已禁止写入以保护原数据。';
    else if (rawStore.datasets && typeof rawStore.datasets === 'object' && !Array.isArray(rawStore.datasets)) {
        store.datasets = rawStore.datasets;
        for (const [key, dataset] of Object.entries(store.datasets)) {
            if (!dataset || typeof dataset !== 'object') { delete store.datasets[key]; continue; }
            dataset.records = normalizeRecords(dataset.records || dataset.companies);
            delete dataset.companies;
            dataset.label = clean(dataset.label) || key;
            dataset.url = clean(dataset.url);
        }
    }
    let legacyRecords = [];
    const legacy = parseStored(GM_getValue(LEGACY_KEY, '{}'), {});
    if (legacy && Array.isArray(legacy.companies)) legacyRecords = normalizeRecords(legacy.companies);
    let settings = parseStored(GM_getValue(SETTINGS_KEY, '{}'), {});
    settings.areaFilter = clean(settings.areaFilter);
    settings.batchLimit = Number.isInteger(settings.batchLimit) ? Math.min(MAX_BATCH, Math.max(1, settings.batchLimit)) : 20;

    let context = pageContext();
    let dataset = null;
    let recordsByKey = new Map();
    let message = '';
    let messageType = '';
    let detailTimer = null;

    function selectDataset(key = context.key) {
        if (!key) return false;
        if (!store.datasets[key]) store.datasets[key] = { label: context.label, url: context.url, records: [], lastUpdated: null };
        dataset = store.datasets[key];
        dataset.records = normalizeRecords(dataset.records);
        dataset.label = clean(dataset.label) || context.label;
        dataset.url = clean(dataset.url) || context.url;
        recordsByKey = new Map(dataset.records.map(record => [recordKey(record), record]));
        return true;
    }

    function saveStore() {
        if (storageIssue) throw new Error(storageIssue);
        if (dataset) dataset.lastUpdated = nowIso();
        try { GM_setValue(STORAGE_KEY, JSON.stringify(store)); }
        catch (error) { throw new Error(`保存失败：${errorText(error)}。当前页面数据仍可导出。`); }
    }

    function saveSettings() {
        settings.areaFilter = clean(ui.area.value);
        settings.batchLimit = Math.min(MAX_BATCH, Math.max(1, Number(ui.limit.value) || 20));
        ui.limit.value = String(settings.batchLimit);
        try { GM_setValue(SETTINGS_KEY, JSON.stringify(settings)); }
        catch (error) { setStatus(`设置保存失败：${errorText(error)}`, 'error'); }
    }

    function getRun() {
        const run = parseStored(GM_getValue(RUN_KEY, '{}'), {});
        return run && typeof run === 'object' ? run : {};
    }

    function saveRun(run) {
        GM_setValue(RUN_KEY, JSON.stringify(run || {}));
    }

    function stopRun(text = '已暂停，任务进度已保存。', type = '') {
        const run = getRun();
        run.active = false;
        saveRun(run);
        if (detailTimer) { clearTimeout(detailTimer); detailTimer = null; }
        setStatus(text, type);
    }

    function visible(element) {
        if (!element || !element.getClientRects().length || element.closest('[hidden], [aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function scanList() {
        if (!selectDataset()) return setStatus('当前不是职位列表页。', 'error');
        saveSettings();
        const cards = [...document.querySelectorAll('.job-card-wrapper, .job-card-box, .job-card-wrap, .job-card')].filter(visible);
        let found = 0;
        let added = 0;
        let updated = 0;
        for (const card of cards) {
            const detailLink = card.querySelector('a[href*="/job_detail/"]');
            const companyLink = card.querySelector('a[href*="/gongsi/"]:not([href*="/gongsi/job/"])');
            if (!detailLink || !companyLink) continue;
            const locationElement = card.querySelector('.job-area, .job-area-wrapper, .company-location, .job-card-footer .job-area');
            const locationText = clean(locationElement && locationElement.textContent || card.textContent);
            if (settings.areaFilter && !locationText.includes(settings.areaFilter)) continue;
            const displayName = [companyLink.getAttribute('title'), companyLink.textContent].map(clean).find(validName) || clean(companyLink.textContent);
            const detailUrl = canonicalUrl(detailLink.href);
            const companyUrl = canonicalUrl(companyLink.href);
            if (!displayName || !detailUrl || !companyUrl) continue;
            found++;
            const key = companyUrl;
            let record = recordsByKey.get(key);
            if (!record) {
                // 尽量把 v1.2 只有简称的记录升级为可补全任务。
                record = dataset.records.find(item => !item.companyUrl && item.displayName === displayName);
            }
            if (!record) {
                record = normalizeRecord({ displayName, location: locationText, detailUrl, companyUrl,
                    status: 'pending', searchUrl: context.url, collectedAt: nowIso() });
                dataset.records.push(record);
                added++;
            } else {
                const before = JSON.stringify(record);
                record.displayName ||= displayName;
                record.location ||= locationText;
                record.detailUrl ||= detailUrl;
                record.companyUrl ||= companyUrl;
                record.searchUrl ||= context.url;
                record.collectedAt ||= nowIso();
                if (!record.legalName && ['legacy', 'error'].includes(record.status)) record.status = 'pending';
                if (before !== JSON.stringify(record)) updated++;
            }
            recordsByKey.set(companyUrl, record);
        }
        try {
            saveStore();
            setStatus(found ? `扫描到 ${found} 家：新增 ${added}，补上链接 ${updated}，待工商补全 ${pendingRecords().length} 家。`
                : `没有识别到符合条件的职位卡片${settings.areaFilter ? `（地址需包含“${settings.areaFilter}”）` : ''}。`, found ? 'success' : 'error');
        } catch (error) { setStatus(errorText(error), 'error'); }
    }

    function pendingRecords() {
        return dataset ? dataset.records.filter(record => record.detailUrl && !record.legalName && record.status === 'pending') : [];
    }

    function retryFailed() {
        if (!selectDataset()) return;
        let count = 0;
        for (const record of dataset.records) {
            if (record.detailUrl && ['error', 'no_info', 'visiting'].includes(record.status) && !record.legalName) {
                record.status = 'pending'; record.lastError = ''; count++;
            }
        }
        try { saveStore(); setStatus(`已将 ${count} 条失败或未识别记录放回待处理队列。`, count ? 'success' : ''); }
        catch (error) { setStatus(errorText(error), 'error'); }
    }

    function nextPending(run) {
        const target = store.datasets[run.datasetKey];
        if (!target) return null;
        target.records = normalizeRecords(target.records);
        return target.records.find(record => record.detailUrl && !record.legalName && record.status === 'pending') || null;
    }

    function visitNext(run) {
        if (!run.active) return;
        if (run.processed >= run.limit) return finishRun(run, `本轮已处理 ${run.processed} 家，返回职位列表。`);
        const record = nextPending(run);
        if (!record) return finishRun(run, `待处理队列已完成，本轮处理 ${run.processed} 家。`);
        record.status = 'visiting';
        record.attempts++;
        record.lastError = '';
        run.currentKey = recordKey(record);
        try { saveStore(); saveRun(run); }
        catch (error) { return stopRun(errorText(error), 'error'); }
        setStatus(`即将进入第 ${run.processed + 1}/${run.limit} 家：${record.displayName}`);
        detailTimer = setTimeout(() => location.assign(record.detailUrl), 800);
    }

    function startBusinessRun() {
        if (!selectDataset()) return setStatus('请回到职位列表页开始批量补全。', 'error');
        saveSettings();
        scanList();
        const pending = pendingRecords();
        if (!pending.length) return setStatus('没有待补全任务。可滚动或翻页后再次“扫描当前列表”，或重试失败项。', 'error');
        const run = {
            active: true,
            datasetKey: context.key,
            returnUrl: context.url,
            limit: settings.batchLimit,
            processed: 0,
            currentKey: '',
            startedAt: nowIso()
        };
        saveRun(run);
        visitNext(run);
    }

    function findField(root, label) {
        const labels = `${label}|${label === '公司名称' ? '公司全称|企业名称' : ''}`.replace(/\|$/, '');
        const regex = new RegExp(`(?:^|\\s)(?:${labels})\\s*[:：]?\\s*(.{2,120}?)(?=\\s*(?:法定代表人|成立日期|企业类型|经营状态|注册资金|注册资本|公司名称|公司全称|企业名称|$))`);
        const nodes = [...root.querySelectorAll('li, dl, dd, section, div')]
            .map(element => clean(element.innerText || element.textContent))
            .filter(text => text.includes(label) && text.length <= 500)
            .sort((a, b) => a.length - b.length);
        for (const text of nodes) {
            const match = text.match(regex);
            const value = clean(match && match[1]);
            if (value) return value;
        }
        return '';
    }

    function extractBusiness(root = document) {
        const bodyText = clean(root.body && (root.body.innerText || root.body.textContent));
        const hasSection = bodyText.includes('工商信息');
        const legalName = findField(root, '公司名称') || findField(root, '公司全称') || findField(root, '企业名称');
        return { hasSection, legalName: validName(legalName) ? legalName : '' };
    }

    function securityBlocked(root = document) {
        if (location.pathname.includes('/web/passport/') || location.pathname.includes('/security')) return true;
        const selectors = '[role="dialog"], .verify-dialog, .verify-wrap, .captcha-box, .security-check';
        return [...root.querySelectorAll(selectors)].some(element => visible(element)
            && /安全验证|完成验证|验证码|访问异常|操作频繁/.test(clean(element.textContent)));
    }

    function currentCompanyMeta() {
        const companyLink = [...document.querySelectorAll('a[href*="/gongsi/"]')]
            .find(link => !link.href.includes('/gongsi/job/') && validName(clean(link.textContent)));
        return {
            displayName: clean(companyLink && companyLink.textContent),
            companyUrl: canonicalUrl(companyLink && companyLink.href),
            detailUrl: canonicalUrl(location.href)
        };
    }

    function finishDetail(run, result, reason = '') {
        const target = store.datasets[run.datasetKey];
        if (!target) return stopRun('对应的列表任务已不存在。', 'error');
        target.records = normalizeRecords(target.records);
        let record = target.records.find(item => recordKey(item) === run.currentKey || item.detailUrl === canonicalUrl(location.href));
        if (!record) {
            record = normalizeRecord({ ...currentCompanyMeta(), status: 'visiting', collectedAt: nowIso() });
            target.records.push(record);
        }
        if (result.legalName) {
            record.legalName = result.legalName;
            record.status = 'done';
            record.lastError = '';
            record.enrichedAt = nowIso();
        } else {
            record.status = result.hasSection ? 'no_info' : 'error';
            record.lastError = reason || (result.hasSection ? '工商信息中未识别到公司名称' : '详情页未出现工商信息');
        }
        run.processed++;
        run.currentKey = '';
        try { saveStore(); saveRun(run); }
        catch (error) { return stopRun(errorText(error), 'error'); }
        if (!run.active) return;
        if (run.processed >= run.limit || !nextPending(run)) return finishRun(run, `本轮处理 ${run.processed} 家，工商成功 ${businessCount(target.records)} 家。`);
        const delay = PAGE_DELAY[0] + Math.random() * (PAGE_DELAY[1] - PAGE_DELAY[0]);
        setStatus(result.legalName ? `已获取：${record.displayName} → ${record.legalName}。${Math.ceil(delay / 1000)} 秒后继续。` : `${record.displayName} 未识别，${Math.ceil(delay / 1000)} 秒后继续。`, result.legalName ? 'success' : 'error');
        detailTimer = setTimeout(() => visitNext(run), delay);
    }

    function finishRun(run, text) {
        run.active = false;
        saveRun(run);
        setStatus(text, 'success');
        detailTimer = setTimeout(() => location.assign(run.returnUrl || '/web/geek/jobs'), 1200);
    }

    function processDetailPage() {
        const run = getRun();
        const started = Date.now();
        function inspect() {
            const currentRun = getRun();
            if (!currentRun.active || currentRun.startedAt !== run.startedAt) return setStatus('批量任务已暂停。');
            if (securityBlocked(document)) return stopRun('检测到网站验证，已暂停。请正常完成验证后回到列表，重试中断项。', 'error');
            const result = extractBusiness(document);
            if (result.legalName) return finishDetail(currentRun, result);
            if (Date.now() - started >= DETAIL_WAIT_MS) return finishDetail(currentRun, result);
            setStatus(`正在等待工商信息加载… ${Math.ceil((DETAIL_WAIT_MS - (Date.now() - started)) / 1000)} 秒`);
            detailTimer = setTimeout(inspect, 1000);
        }
        inspect();
    }

    function collectThisDetail() {
        const result = extractBusiness(document);
        if (!result.legalName) return setStatus(result.hasSection ? '看到了工商信息，但没有识别到公司名称。' : '当前页尚未加载工商信息。', 'error');
        const meta = currentCompanyMeta();
        // 手动详情采集没有原列表上下文时，存入独立分组。
        const key = context.key || 'manual-details';
        if (!store.datasets[key]) store.datasets[key] = { label: '手动详情采集', url: location.href, records: [], lastUpdated: null };
        dataset = store.datasets[key];
        dataset.records = normalizeRecords(dataset.records);
        let record = dataset.records.find(item => item.companyUrl && item.companyUrl === meta.companyUrl || item.detailUrl === meta.detailUrl);
        if (!record) { record = normalizeRecord({ ...meta, collectedAt: nowIso() }); dataset.records.push(record); }
        record.legalName = result.legalName; record.status = 'done'; record.enrichedAt = nowIso(); record.lastError = '';
        try { saveStore(); setStatus(`已保存工商公司名称：${result.legalName}`, 'success'); }
        catch (error) { setStatus(errorText(error), 'error'); }
    }

    function businessCount(records = dataset && dataset.records || []) {
        return records.filter(record => record.legalName).length;
    }

    function stats() {
        const records = dataset && dataset.records || [];
        return {
            total: records.length,
            done: businessCount(records),
            pending: records.filter(record => record.status === 'pending').length,
            failed: records.filter(record => ['error', 'no_info', 'visiting'].includes(record.status)).length
        };
    }

    function csvCell(value) {
        let text = String(value == null ? '' : value);
        if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
    }

    function buildCSV(records) {
        const rows = [['列表公司名', '工商公司名称', '状态', '职位地区', '公司详情链接', '职位详情链接', '搜索页面', '首次收集时间', '工商补全时间', '失败原因']];
        const statusText = { done: '工商全称成功', pending: '待补全', visiting: '处理中断', no_info: '未识别工商名称', error: '详情失败', legacy: '旧版仅简称' };
        for (const record of records) rows.push([
            record.displayName, record.legalName, statusText[record.status] || record.status, record.location,
            record.companyUrl, record.detailUrl, record.searchUrl, record.collectedAt, record.enrichedAt, record.lastError
        ]);
        return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    }

    function downloadCSV(records, label) {
        if (!records.length) return setStatus('没有数据可导出。', 'error');
        const now = new Date();
        const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const filename = `boss_company_${clean(label).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 60)}_${date}.csv`;
        const blob = new Blob([buildCSV(records)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const fallback = () => {
            const link = document.createElement('a');
            link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        };
        try {
            if (typeof GM_download !== 'function') return fallback();
            GM_download({ url, name: filename, saveAs: true,
                onload: () => { URL.revokeObjectURL(url); setStatus(`已导出 ${records.length} 条。`, 'success'); },
                onerror: fallback });
        } catch (_) { fallback(); }
    }

    function exportCurrent(successOnly) {
        if (!dataset) return setStatus('当前没有可导出的列表数据。', 'error');
        const records = successOnly ? dataset.records.filter(record => record.legalName) : dataset.records;
        downloadCSV(records, `${dataset.label}_${successOnly ? '工商全称' : '全部'}`);
    }

    function exportHistory() {
        const all = normalizeRecords([...Object.values(store.datasets).flatMap(item => item.records || []), ...legacyRecords]);
        downloadCSV(all, '全部历史');
    }

    function clearCurrent() {
        if (!dataset || !confirm(`确认清空“${dataset.label}”的全部记录？其他搜索和旧版数据保留。`)) return;
        stopRun();
        const previous = dataset.records;
        dataset.records = [];
        try { saveStore(); recordsByKey.clear(); setStatus('当前搜索记录已清空。'); }
        catch (error) { dataset.records = previous; setStatus(errorText(error), 'error'); }
    }

    GM_addStyle(`
        #bp-panel{position:fixed;top:70px;right:18px;width:350px;max-width:calc(100vw - 36px);box-sizing:border-box;
            background:#fff;border:2px solid #00a980;border-radius:9px;padding:14px;z-index:999999;
            font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#333;box-shadow:0 7px 24px #0003}
        #bp-panel *{box-sizing:border-box} #bp-panel [hidden]{display:none!important}
        #bp-panel .bp-title{display:flex;align-items:center;justify-content:space-between;font-weight:700;color:#00876a;font-size:15px}
        #bp-panel .bp-row{margin:6px 0;overflow-wrap:anywhere} #bp-panel b{color:#00876a}
        #bp-panel .bp-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
        #bp-panel button{background:#fff;color:#00876a;border:1px solid #00a980;padding:5px 9px;border-radius:4px;cursor:pointer;font:inherit}
        #bp-panel .bp-primary{background:#00876a;color:#fff} #bp-panel button:disabled{opacity:.5;cursor:default}
        #bp-panel input{padding:4px;border:1px solid #bbb;border-radius:3px;font:inherit}
        #bp-panel input[type=text]{width:90px} #bp-panel input[type=number]{width:58px}
        #bp-panel .bp-note{font-size:12px;color:#666;margin-top:8px}
        #bp-panel .bp-status{margin-top:8px;padding:6px 8px;background:#f5f5f5;border-radius:4px;font-size:12px;overflow-wrap:anywhere}
        #bp-panel .bp-status.error{background:#fff0f0;color:#b22} #bp-panel .bp-status.success{background:#eef9f4;color:#087153}
    `);
    const panel = document.createElement('div');
    panel.id = 'bp-panel';
    const isDetail = location.pathname.startsWith('/job_detail/');
    panel.innerHTML = `
        <div class="bp-title">🏢 工商公司名采集 v1.3.0 <button id="bp-collapse" aria-label="折叠采集面板">收起</button></div>
        <div id="bp-body">
            <div class="bp-row" id="bp-target"></div>
            <div class="bp-row" id="bp-stats"></div>
            <div id="bp-list-controls" ${isDetail ? 'hidden' : ''}>
                <label>地址包含 <input id="bp-area" type="text" placeholder="如：义乌市"></label>
                <label>本轮最多 <input id="bp-limit" type="number" min="1" max="100"> 家</label>
                <div class="bp-btns">
                    <button id="bp-scan">扫描当前列表</button><button class="bp-primary" id="bp-start">开始工商补全</button>
                    <button id="bp-retry">重试失败项</button><button id="bp-pause">暂停</button>
                </div>
            </div>
            <div class="bp-btns">
                <button id="bp-this" ${isDetail ? '' : 'hidden'}>保存本页工商名称</button>
                <button id="bp-export-ok">导出工商全称</button><button id="bp-export-all">导出本搜索全部</button>
                <button id="bp-history">导出全部历史</button><button id="bp-clear" ${isDetail ? 'hidden' : ''}>清空本搜索</button>
            </div>
            <div class="bp-note">先扫描列表，再逐个进入职位详情读取“工商信息 → 公司名称”。单线程间隔 6–10 秒；遇到网站验证请正常处理，不会绕过验证。</div>
            <div class="bp-status" id="bp-status" role="status" aria-live="polite"></div>
        </div>`;
    document.body.appendChild(panel);
    const ui = {};
    for (const id of ['body','target','stats','list-controls','area','limit','scan','start','retry','pause','this','export-ok','export-all','history','clear','status','collapse']) {
        ui[id] = panel.querySelector(`#bp-${id}`);
    }
    ui.area.value = settings.areaFilter;
    ui.limit.value = String(settings.batchLimit);

    function updatePanel() {
        const run = getRun();
        if (!isDetail) selectDataset();
        else if (run.datasetKey) selectDataset(run.datasetKey);
        const currentStats = stats();
        ui.target.textContent = isDetail ? '当前：职位详情页' : `当前搜索：${context.label}`;
        ui.stats.innerHTML = `候选 <b>${currentStats.total}</b> · 工商成功 <b>${currentStats.done}</b> · 待处理 <b>${currentStats.pending}</b> · 失败/中断 <b>${currentStats.failed}</b>`;
        ui.status.textContent = message || (isDetail ? '正在检查本页工商信息…' : '先滚动到职位结果，扫描当前列表。');
        ui.status.className = `bp-status ${messageType}`;
    }
    function setStatus(text, type = '') { message = text; messageType = type; updatePanel(); }

    ui.scan.onclick = scanList;
    ui.start.onclick = startBusinessRun;
    ui.retry.onclick = retryFailed;
    ui.pause.onclick = () => stopRun();
    ui.this.onclick = collectThisDetail;
    ui['export-ok'].onclick = () => exportCurrent(true);
    ui['export-all'].onclick = () => exportCurrent(false);
    ui.history.onclick = exportHistory;
    ui.clear.onclick = clearCurrent;
    ui.area.onchange = saveSettings;
    ui.limit.onchange = saveSettings;
    ui.collapse.onclick = () => {
        ui.body.hidden = !ui.body.hidden;
        ui.collapse.textContent = ui.body.hidden ? '展开' : '收起';
    };

    if (!isDetail) {
        const interrupted = getRun();
        if (interrupted.active) {
            interrupted.active = false;
            saveRun(interrupted);
            message = '检测到上次批量任务在列表页中断，已暂停；可继续处理待办。';
        }
        selectDataset();
    }
    updatePanel();
    if (isDetail) {
        const run = getRun();
        if (run.active) processDetailPage();
        else {
            const result = extractBusiness(document);
            if (result.legalName) setStatus(`本页工商公司名称：${result.legalName}`, 'success');
        }
    }
})();
