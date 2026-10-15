// ==UserScript==
// @name         ✨ 网站油猴脚本发现器 v6.1.1 · 多线路自由切换 ✨
// @namespace    http://tampermonkey.net/
// @version      6.1.1
// @description  在当前网站一键查找可用的 GreasyFork 脚本。多线路自动回退（官方直连 / Jina 中转 / 自定义中转），右键图标可自由指定线路，网络失败与真的没有结果分开显示，带重试、诊断与按钮位置自愈。
// @author       一只会飞的旺旺 (Optimized by AI)
// @homepageURL  https://github.com/qibo30/userscript-finder
// @supportURL   https://github.com/qibo30/userscript-finder/issues
// @updateURL    https://ghproxy.net/https://raw.githubusercontent.com/qibo30/userscript-finder/main/userscript-finder.user.js
// @downloadURL  https://gh-proxy.com/https://raw.githubusercontent.com/qibo30/userscript-finder/main/userscript-finder.user.js
// @match        *://*/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      greasyfork.org
// @connect      r.jina.ai
// @connect      *
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/*
 * v6 修复清单（对应 v5.2 的真实故障）
 *  1. 【核心】v5.2 请求失败时 catch 里 return []，UI 与「真的没有脚本」共用同一句
 *     「未找到适用于 X 的脚本」——用户看到的就是这句话，但其实请求根本没成功。
 *     现在：抓取层区分「线路失败」与「确实为空」，UI 分开显示，并给出失败原因。
 *  2. 多线路自动回退：greasyfork.org 在部分网络下会被 TLS/SNI 重置，
 *     自动改用中转线路，并记住可用线路。
 *  3. 失败后无法重试：v5.2 用 container.dataset.loaded 把首次失败也标记为「已加载」。
 *     现在每次打开都可重试，并新增「重试」按钮。
 *  4. 按钮坐标从存储读出后不做视口校验，一旦存过屏外坐标就永远看不见，
 *     而重置入口（面板按钮 / 右键菜单）也跟着看不见 → 无恢复路径。
 *     现在：加载与窗口尺寸变化时自动夹回视口，并注册油猴菜单兜底。
 *  5. daily_installs 被特判成不发 sort 参数（v5.2 第 83 行），该选项实际无效。
 *  6. 无 @noframes：v5.2 会在页面每个 iframe 里各注入一套按钮与面板。
 *  7. 强制「一年内更新」过滤 + 固定 20 条，导致结果偏少偏旧。现在可调。
 *  8. 用 innerHTML 直接拼接脚本标题/描述（第三方内容），存在 XSS 风险。改为 textContent。
 *  9. 广告位 <li class="ad-entry"> 会被解析成标题为 Untitled、链接为 # 的假条目。现在跳过。
 * 10. 新增本地搜索、评分/日安装量展示、结果缓存、Alt+F 快捷键。
 *
 * v6.1 新增
 * 11. 右键菜单新增「切换线路…」一行（右侧显示当前线路），点击才展开子菜单，
 *     里面列出 自动 / 官方直连 / Jina 中转 / 自定义中转，点哪条就用哪条，当前生效的打勾。
 *     手动指定后不再自动回退——用户点名要哪条就只用哪条，失败会明确报出来并提供「切回自动」。
 *
 * v6.1.1
 * 12. 增加 @updateURL / @downloadURL / @homepageURL / @supportURL，
 *     Tampermonkey 可自动检查更新。更新地址走国内镜像（raw.githubusercontent.com 国内直连不通），
 *     镜像实测国内可直连且内容与官方 raw 一致。
 */

(function () {
    'use strict';

    /* ============================ 常量 ============================ */

    const LOG = '[脚本发现器]';
    const ANIMATION_DURATION = 300;
    const DRAG_SENSITIVITY = 0.8;

    const DEFAULT_POSITION = { top: 20, right: 20, bottom: 'auto', left: 'auto' };

    const SORT_OPTIONS = {
        total_installs: '总安装量',
        daily_installs: '日安装量',
        rating: '评分',
        updated: '最近更新',
        created: '最近创建',
        name: '名称',
    };
    const DEFAULT_SORT = 'total_installs';

    const LIMIT_OPTIONS = { '20': '20 条', '50': '50 条', '100': '100 条', '0': '全部' };
    const DEFAULT_LIMIT = '50';

    const CACHE_TTL_MS = 30 * 60 * 1000;
    const DIRECT_TIMEOUT_MS = 12000;
    const RELAY_TIMEOUT_MS = 30000;

    /**
     * 数据线路。按顺序探测，第一个成功解析的线路会被记住并优先复用。
     * build(url) 把 GreasyFork 原始地址改写成该线路实际请求的地址。
     */
    const CHANNELS = [
        {
            id: 'direct',
            label: '官方直连',
            build: (url) => url,
            headers: {},
            timeout: DIRECT_TIMEOUT_MS,
        },
        {
            id: 'jina',
            label: 'Jina 中转',
            build: (url) => 'https://r.jina.ai/' + url,
            headers: { 'x-return-format': 'html' },
            timeout: RELAY_TIMEOUT_MS,
        },
    ];

    /** 空结果页面的特征文案（GreasyFork 确实没有该站点脚本时会渲染这些） */
    const EMPTY_MARKERS = ['找不到相关脚本', 'No scripts found', '没有找到相关脚本'];

    /* ============================ 存储 ============================ */

    function store(key, fallback) {
        try {
            const v = GM_getValue(key, undefined);
            return v === undefined || v === null ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function save(key, value) {
        try {
            GM_setValue(key, value);
        } catch (e) {
            console.warn(LOG, '写入设置失败', e);
        }
    }

    /* ============================ 域名 ============================ */

    const fullHostname = location.hostname;
    const rootDomain = getRootDomain(fullHostname);

    function getRootDomain(hostname) {
        if (!hostname || /^\d+(\.\d+){3}$/.test(hostname) || hostname === 'localhost') return hostname;
        const parts = hostname.split('.');
        const commonSLDs = /^(co|com|net|org|gov|edu)\.\w{2}$/;
        if (parts.length > 2) {
            const lastTwo = parts.slice(-2).join('.');
            if (commonSLDs.test(lastTwo)) return parts.slice(-3).join('.');
            return lastTwo;
        }
        return hostname;
    }

    /* ============================ 抓取层 ============================ */

    function gmFetch(options) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (fn, arg) => {
                if (settled) return;
                settled = true;
                fn(arg);
            };
            GM_xmlhttpRequest({
                method: 'GET',
                url: options.url,
                headers: options.headers || {},
                timeout: options.timeout,
                onload: (r) => done(resolve, r),
                onerror: () => done(reject, new Error('连接失败')),
                ontimeout: () => done(reject, new Error('请求超时')),
                onabort: () => done(reject, new Error('请求被中止')),
            });
        });
    }

    /** 自定义中转：用户填的前缀会直接拼在原始地址前面 */
    function customRelay() {
        const prefix = String(store('custom_relay', '') || '').trim();
        if (!prefix) return null;
        return {
            id: 'custom',
            label: '自定义中转',
            build: (url) => prefix + url,
            headers: { 'x-return-format': 'html' },
            timeout: RELAY_TIMEOUT_MS,
        };
    }

    function allChannels() {
        const list = CHANNELS.slice();
        const custom = customRelay();
        if (custom) list.push(custom);
        return list;
    }

    /**
     * 线路尝试顺序。
     * 用户手动指定过线路（channel_lock）就严格只用那一条 —— 手动选择的意图优先于自动回退。
     * 否则把上次成功的线路提到最前，其余按默认顺序跟在后面。
     */
    function orderedChannels() {
        const list = allChannels();

        const lock = store('channel_lock', '');
        if (lock) {
            const pinned = list.filter((c) => c.id === lock);
            if (pinned.length) return pinned;
            save('channel_lock', '');   // 锁定的线路已不存在（例如自定义中转被清空），解除锁定
        }

        const preferred = store('working_channel', '');
        if (!preferred) return list;
        const idx = list.findIndex((c) => c.id === preferred);
        if (idx <= 0) return list;
        return [list[idx]].concat(list.slice(0, idx), list.slice(idx + 1));
    }

    /**
     * 解析 GreasyFork 的 by-site 页面。
     * 返回 { items, empty, recognized }：
     *   recognized=false 表示内容根本不是 by-site 页面（被拦截 / 挑战页 / 错误页），应换线路。
     *   empty=true 表示确实是「该站点没有脚本」。
     */
    function parseList(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const list = doc.querySelector('#browse-script-list');

        if (!list) {
            const text = doc.body ? doc.body.textContent || '' : '';
            const isEmpty = EMPTY_MARKERS.some((m) => text.indexOf(m) !== -1);
            return { items: [], empty: isEmpty, recognized: isEmpty };
        }

        const items = [];
        list.querySelectorAll('li').forEach((li) => {
            if (li.classList.contains('ad-entry')) return; // 广告位，不是脚本
            const link = li.querySelector('a.script-link');
            const href = link ? link.getAttribute('href') : null;
            if (!href) return;

            let authors = [];
            try {
                const raw = li.dataset.scriptAuthors;
                if (raw) authors = Object.values(JSON.parse(raw));
            } catch (e) {
                authors = [];
            }

            items.push({
                id: li.dataset.scriptId || '',
                title: li.dataset.scriptName || (link ? link.textContent.trim() : '未命名'),
                url: 'https://greasyfork.org' + href,
                installs: parseInt(li.dataset.scriptTotalInstalls, 10) || 0,
                dailyInstalls: parseInt(li.dataset.scriptDailyInstalls, 10) || 0,
                rating: parseFloat(li.dataset.scriptRatingScore) || 0,
                updatedDate: li.dataset.scriptUpdatedDate || '',
                createdDate: li.dataset.scriptCreatedDate || '',
                author: authors.join(', ') || '未知',
                description: (li.querySelector('.script-description') || {}).textContent
                    ? li.querySelector('.script-description').textContent.trim()
                    : '',
            });
        });

        return { items, empty: items.length === 0, recognized: true };
    }

    function buildBySiteUrl(domain, sortBy) {
        const params = new URLSearchParams();
        if (sortBy) params.set('sort', sortBy);
        const qs = params.toString();
        return 'https://greasyfork.org/zh-CN/scripts/by-site/' + encodeURIComponent(domain) + (qs ? '?' + qs : '');
    }

    /**
     * 依次尝试各线路，返回 { items, empty, channel }。
     * 全部失败则抛出，message 汇总每条线路的失败原因。
     */
    async function fetchScripts(domain, sortBy) {
        const url = buildBySiteUrl(domain, sortBy);
        const failures = [];

        for (const ch of orderedChannels()) {
            const target = ch.build(url);
            try {
                console.log(LOG, `线路「${ch.label}」请求 ${target}`);
                const res = await gmFetch({ url: target, headers: ch.headers, timeout: ch.timeout });

                if (res.status !== 200) {
                    failures.push(`${ch.label}: HTTP ${res.status}`);
                    continue;
                }
                const parsed = parseList(res.responseText);
                if (!parsed.recognized) {
                    failures.push(`${ch.label}: 返回内容无法识别（可能被拦截或需要验证）`);
                    continue;
                }

                save('working_channel', ch.id);
                console.log(LOG, `线路「${ch.label}」成功，解析到 ${parsed.items.length} 条`);
                return { items: parsed.items, empty: parsed.empty, channel: ch };
            } catch (e) {
                failures.push(`${ch.label}: ${e.message}`);
                console.warn(LOG, `线路「${ch.label}」失败：`, e.message);
            }
        }

        const locked = store('channel_lock', '');
        const err = new Error(
            failures.join('\n') + (locked ? '\n\n（当前为手动指定线路，不会自动回退到其他线路）' : '')
        );
        err.failures = failures;
        err.locked = !!locked;
        throw err;
    }

    /* ============================ 缓存 ============================ */

    function cacheKey(domain, sortBy) {
        return `cache_v6::${domain}::${sortBy}`;
    }

    function readCache(domain, sortBy) {
        const c = store(cacheKey(domain, sortBy), null);
        if (!c || typeof c !== 'object' || !Array.isArray(c.items)) return null;
        if (Date.now() - (c.ts || 0) > CACHE_TTL_MS) return null;
        return c;
    }

    function writeCache(domain, sortBy, items, channelLabel) {
        save(cacheKey(domain, sortBy), { ts: Date.now(), items, channelLabel });
    }

    /* ============================ 状态 ============================ */

    const state = {
        items: [],
        loading: false,
        error: null,
        channelLabel: '',
        fromCache: false,
    };

    let els = null;

    /* ============================ 样式 ============================ */

    function injectStyles() {
        GM_addStyle(`
            :root { --uf-hidden-transform: translateX(calc(100% + 20px)); }

            #uf-container {
                position: fixed; top: 20px; right: 20px;
                width: 420px; max-width: 95vw; max-height: 82vh;
                background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
                border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                z-index: 2147483600; color: #ecf0f1;
                font-family: 'Segoe UI', 'Roboto', 'Microsoft YaHei', sans-serif;
                font-size: 13px; overflow: hidden;
                display: flex; flex-direction: column;
                transform: var(--uf-hidden-transform);
                transition: transform ${ANIMATION_DURATION}ms ease-in-out;
            }
            #uf-container.show { transform: translateX(0) translateY(0); }

            #uf-header { padding: 14px 16px 0; background: rgba(0,0,0,0.15); flex-shrink: 0; }
            #uf-header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
            #uf-title { font-size: 16px; font-weight: 700; margin: 0; }
            #uf-close {
                background: none; border: none; color: #ecf0f1; font-size: 22px;
                cursor: pointer; width: 28px; height: 28px; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                transition: background-color .2s, transform .2s;
            }
            #uf-close:hover { background: rgba(255,255,255,.12); transform: rotate(90deg); }

            .uf-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; flex-wrap: wrap; }
            .uf-row label { font-size: 12px; opacity: .8; }

            #uf-search, .uf-select {
                background: rgba(0,0,0,.3); color: #ecf0f1;
                border: 1px solid rgba(255,255,255,.3); border-radius: 4px;
                padding: 5px 8px; font-size: 12px; outline: none;
            }
            #uf-search { flex: 1 1 120px; min-width: 90px; }
            #uf-search::placeholder { color: rgba(236,240,241,.45); }
            #uf-search:focus, .uf-select:focus { border-color: #87ceeb; }
            .uf-select option { background: #34495e; color: #ecf0f1; }

            .uf-btn {
                background: rgba(255,255,255,.1); color: #ecf0f1;
                border: 1px solid rgba(255,255,255,.3); border-radius: 4px;
                padding: 5px 10px; font-size: 12px; cursor: pointer;
                transition: background-color .2s, transform .1s;
            }
            .uf-btn:hover { background: rgba(255,255,255,.2); }
            .uf-btn:active { transform: scale(.97); }
            .uf-btn[disabled] { opacity: .5; cursor: default; }
            .uf-spacer { margin-left: auto; }

            #uf-status {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 16px; font-size: 11px; opacity: .85;
                border-bottom: 1px solid rgba(255,255,255,.12);
                flex-shrink: 0; line-height: 1.5;
            }
            #uf-channel {
                background: rgba(135,206,235,.18); border: 1px solid rgba(135,206,235,.45);
                color: #add8e6; border-radius: 10px; padding: 1px 8px; font-size: 10px;
                white-space: nowrap; flex-shrink: 0;
            }

            #uf-content { overflow-y: auto; flex: 1 1 auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.3) transparent; }
            #uf-content::-webkit-scrollbar { width: 8px; }
            #uf-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,.3); border-radius: 4px; }

            .uf-item { padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,.1); transition: background-color .2s; }
            .uf-item:hover { background: rgba(255,255,255,.07); }
            .uf-item:last-child { border-bottom: none; }
            .uf-item-title { font-size: 14px; font-weight: 600; margin: 0 0 5px; line-height: 1.35; }
            .uf-item-title a { color: #add8e6; text-decoration: none; }
            .uf-item-title a:hover { text-decoration: underline; color: #87ceeb; }
            .uf-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; opacity: .72; margin-bottom: 5px; }
            .uf-desc {
                font-size: 12px; opacity: .62; line-height: 1.5; margin: 0;
                display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
            }
            .uf-state { padding: 34px 20px; text-align: center; line-height: 1.7; opacity: .9; }
            .uf-state strong { display: block; margin-bottom: 8px; font-size: 14px; }
            .uf-state .uf-hint { font-size: 12px; opacity: .75; }
            .uf-details { margin-top: 14px; text-align: left; font-size: 11px; }
            .uf-details summary { cursor: pointer; opacity: .7; }
            .uf-details pre {
                white-space: pre-wrap; word-break: break-all; margin: 8px 0 0;
                background: rgba(0,0,0,.28); border-radius: 6px; padding: 10px;
                font-size: 11px; line-height: 1.6; max-height: 180px; overflow: auto;
            }

            #uf-toggle {
                position: fixed; width: 52px; height: 52px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                border: none; border-radius: 50%; color: #fff; font-size: 21px;
                cursor: move; box-shadow: 0 4px 15px rgba(0,0,0,.4);
                z-index: 2147483599; display: flex; align-items: center; justify-content: center;
                user-select: none; transition: opacity .2s, transform .2s, box-shadow .2s;
            }
            #uf-toggle:hover { opacity: .9; transform: scale(1.05); }
            #uf-toggle.hidden { display: none; }
            #uf-toggle.minimized { opacity: .6; transform: scale(.7); }
            #uf-toggle.position-saved { box-shadow: 0 0 0 4px rgba(255,255,255,.6); }
            #uf-toggle.is-dragging { cursor: grabbing; opacity: .7; }
            #uf-toggle.uf-attention { animation: uf-pulse 1.6s ease-in-out 2; }
            @keyframes uf-pulse {
                0%,100% { box-shadow: 0 4px 15px rgba(0,0,0,.4); }
                50% { box-shadow: 0 0 0 10px rgba(135,206,235,.45); }
            }

            .uf-menu {
                position: absolute; background: rgba(44,62,80,.98);
                border: 1px solid rgba(255,255,255,.2); border-radius: 6px;
                box-shadow: 0 6px 15px rgba(0,0,0,.4); padding: 6px 0;
                z-index: 2147483601; font-size: 13px;
                font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
                min-width: 190px; max-height: 70vh; overflow-y: auto;
            }
            .uf-menu-title {
                padding: 6px 15px 4px; font-size: 11px; letter-spacing: .05em;
                color: rgba(236,240,241,.55); cursor: default; user-select: none;
            }
            .uf-menu-item {
                padding: 8px 15px; cursor: pointer; color: #ecf0f1;
                white-space: nowrap; display: flex; align-items: center; gap: 8px;
            }
            .uf-menu-item:hover { background: rgba(255,255,255,.12); }
            .uf-menu-item.is-active { color: #6ee7a8; }
            .uf-menu-check { width: 12px; flex: 0 0 12px; text-align: center; }
            .uf-menu-sub { color: rgba(236,240,241,.5); font-size: 11px; margin-left: auto; }
            .uf-menu-item.is-active .uf-menu-sub { color: rgba(110,231,168,.7); }
            .uf-menu-sep { height: 1px; background: rgba(255,255,255,.15); margin: 6px 0; }

            /* 线路子菜单：默认收起，点「切换线路…」才展开 */
            .uf-menu-arrow { margin-left: 6px; color: rgba(236,240,241,.6); font-size: 14px; line-height: 1; }
            .uf-menu-item.is-open { background: rgba(255,255,255,.1); }
            .uf-submenu { display: none; }
            .uf-submenu.open { display: block; }
            .uf-submenu-item { padding-left: 30px; }

            @media (max-width: 768px) {
                :root { --uf-hidden-transform: translateY(100%); }
                #uf-container {
                    top: auto; bottom: 0; right: 0; left: 0;
                    width: 100%; max-width: 100%; max-height: 72vh;
                    border-radius: 16px 16px 0 0;
                }
                #uf-header { padding: 12px 14px 0; }
                #uf-status { padding: 8px 14px; }
                .uf-item { padding: 11px 14px; }
            }
        `);
    }

    /* ============================ 位置 ============================ */

    const TOGGLE_SIZE = 52;
    const EDGE = 10;

    function normalizePosition(pos) {
        const out = { top: 'auto', right: 'auto', bottom: 'auto', left: 'auto' };
        ['top', 'right', 'bottom', 'left'].forEach((k) => {
            const v = pos && pos[k];
            if (v === 'auto' || v === undefined || v === null) out[k] = 'auto';
            else if (typeof v === 'number' && isFinite(v)) out[k] = v;
            else if (typeof v === 'string' && /^-?\d+(\.\d+)?px$/.test(v)) out[k] = parseFloat(v);
            else out[k] = 'auto';
        });
        return out;
    }

    /** 判断一个坐标是否真的能在当前视口里看到按钮 */
    function isPositionVisible(pos) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left, top;
        if (typeof pos.left === 'number') left = pos.left;
        else if (typeof pos.right === 'number') left = vw - pos.right - TOGGLE_SIZE;
        else return false;

        if (typeof pos.top === 'number') top = pos.top;
        else if (typeof pos.bottom === 'number') top = vh - pos.bottom - TOGGLE_SIZE;
        else return false;

        // 至少要有半个按钮落在视口内
        return left + TOGGLE_SIZE / 2 > 0 && left < vw - TOGGLE_SIZE / 2 &&
               top + TOGGLE_SIZE / 2 > 0 && top < vh - TOGGLE_SIZE / 2;
    }

    /** 把坐标夹回视口，保证按钮永远可见 */
    function clampPosition(pos) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const out = { top: 'auto', right: 'auto', bottom: 'auto', left: 'auto' };

        let left;
        if (typeof pos.left === 'number') left = pos.left;
        else if (typeof pos.right === 'number') left = vw - pos.right - TOGGLE_SIZE;
        else left = EDGE;

        let top;
        if (typeof pos.top === 'number') top = pos.top;
        else if (typeof pos.bottom === 'number') top = vh - pos.bottom - TOGGLE_SIZE;
        else top = EDGE;

        left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - TOGGLE_SIZE - EDGE));
        top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - TOGGLE_SIZE - EDGE));

        // 靠近哪条边就贴哪条边，保持拖动后的视觉位置
        if (vw - (left + TOGGLE_SIZE) < left) out.right = Math.max(EDGE, vw - (left + TOGGLE_SIZE));
        else out.left = left;

        if (vh - (top + TOGGLE_SIZE) < top) out.bottom = Math.max(EDGE, vh - (top + TOGGLE_SIZE));
        else out.top = top;

        return out;
    }

    function loadPosition() {
        const raw = normalizePosition(store('button_position', DEFAULT_POSITION));
        if (!isPositionVisible(raw)) {
            console.warn(LOG, '保存的按钮坐标不可见，已重置到默认位置', raw);
            save('button_position', DEFAULT_POSITION);
            return normalizePosition(DEFAULT_POSITION);
        }
        return raw;
    }

    function applyPosition(el, pos) {
        ['top', 'right', 'bottom', 'left'].forEach((k) => {
            const v = pos[k];
            el.style[k] = typeof v === 'number' ? `${v}px` : 'auto';
        });
    }

    /* ============================ 渲染 ============================ */

    function renderStatus() {
        if (!els) return;
        const parts = [];
        if (state.loading) {
            parts.push('<span>正在获取脚本…</span>');
        } else if (state.error) {
            parts.push('<span>获取失败</span>');
        } else {
            const shown = visibleItems().length;
            const total = state.items.length;
            parts.push(`<span>共 ${total} 条${shown !== total ? `，匹配 ${shown} 条` : ''}${state.fromCache ? '（缓存）' : ''}</span>`);
        }
        if (state.channelLabel) {
            const locked = store('channel_lock', '');
            const tag = locked ? '指定' : '自动';
            parts.push(`<span id="uf-channel">${tag} · ${escapeHtml(state.channelLabel)}</span>`);
        }
        els.status.innerHTML = parts.join('');
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        })[c]);
    }

    function formatDate(d) {
        return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
    }

    function visibleItems() {
        const q = (els && els.search.value || '').trim().toLowerCase();
        const recentOnly = !!(els && els.recent.checked);
        const limit = parseInt(els && els.limit.value, 10);

        let list = state.items;
        if (q) {
            list = list.filter((s) =>
                s.title.toLowerCase().indexOf(q) !== -1 ||
                s.author.toLowerCase().indexOf(q) !== -1 ||
                (s.description || '').toLowerCase().indexOf(q) !== -1);
        }
        if (recentOnly) {
            const cutoff = new Date();
            cutoff.setFullYear(cutoff.getFullYear() - 1);
            list = list.filter((s) => s.updatedDate && new Date(s.updatedDate) >= cutoff);
        }
        return limit > 0 ? list.slice(0, limit) : list;
    }

    function renderContent() {
        if (!els) return;

        if (state.loading) {
            els.content.innerHTML = '<div class="uf-state"><strong>正在获取脚本…</strong>'
                + '<div class="uf-hint">首次使用中转线路会稍慢，请稍候</div></div>';
            return;
        }

        if (state.error) {
            const detail = escapeHtml(state.error.message || String(state.error));
            const locked = !!state.error.locked;
            els.content.innerHTML =
                '<div class="uf-state">'
                + '<strong>没能取到脚本列表</strong>'
                + '<div class="uf-hint">'
                + (locked
                    ? '你手动指定了线路，所以不会自动回退。可以改用其他线路，或切回「自动」。'
                    : '所有可用线路都失败了。这通常不是「没有脚本」，而是网络无法访问 GreasyFork。')
                + '</div>'
                + '<div style="margin-top:14px">'
                + '<button class="uf-btn" id="uf-retry">重试</button>'
                + (locked ? '<button class="uf-btn" id="uf-unlock" style="margin-left:8px">切回自动</button>' : '')
                + '</div>'
                + '<details class="uf-details"><summary>查看诊断详情</summary><pre>' + detail + '</pre></details>'
                + '</div>';
            const retry = els.content.querySelector('#uf-retry');
            if (retry) retry.addEventListener('click', () => refresh(true));
            const unlock = els.content.querySelector('#uf-unlock');
            if (unlock) unlock.addEventListener('click', () => selectChannel(''));
            return;
        }

        if (!state.items.length) {
            els.content.innerHTML =
                '<div class="uf-state"><strong>这个站点确实还没有脚本</strong>'
                + '<div class="uf-hint">GreasyFork 上没有针对 '
                + escapeHtml(rootDomain)
                + ' 的用户脚本。<br>线路正常，只是真的没有结果。</div></div>';
            return;
        }

        const list = visibleItems();
        if (!list.length) {
            els.content.innerHTML =
                '<div class="uf-state"><strong>没有符合筛选条件的脚本</strong>'
                + '<div class="uf-hint">试试清空搜索框，或取消「仅看近一年」。</div></div>';
            return;
        }

        const frag = document.createDocumentFragment();
        list.forEach((s) => {
            const item = document.createElement('div');
            item.className = 'uf-item';

            const h = document.createElement('h4');
            h.className = 'uf-item-title';
            const a = document.createElement('a');
            a.href = s.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = s.title;          // 第三方内容，一律用 textContent
            h.appendChild(a);

            const meta = document.createElement('div');
            meta.className = 'uf-meta';
            const bits = [];
            if (s.author && s.author !== '未知') bits.push(`作者: ${s.author}`);
            if (s.installs) bits.push(`${s.installs.toLocaleString()} 安装`);
            if (s.dailyInstalls) bits.push(`日装 ${s.dailyInstalls.toLocaleString()}`);
            if (s.rating) bits.push(`评分 ${s.rating}`);
            if (formatDate(s.updatedDate)) bits.push(`更新于 ${s.updatedDate}`);
            bits.forEach((b) => {
                const span = document.createElement('span');
                span.textContent = b;
                meta.appendChild(span);
            });

            item.appendChild(h);
            item.appendChild(meta);

            if (s.description) {
                const p = document.createElement('p');
                p.className = 'uf-desc';
                p.textContent = s.description;
                item.appendChild(p);
            }
            frag.appendChild(item);
        });

        els.content.innerHTML = '';
        els.content.appendChild(frag);
    }

    function renderAll() {
        if (!els) return;
        els.title.textContent = state.error
            ? '脚本查找器 · 出错了'
            : `脚本查找器${state.items.length ? ` (${visibleItems().length})` : ''}`;
        renderStatus();
        renderContent();
    }

    /* ============================ 刷新 ============================ */

    async function refresh(force) {
        if (state.loading) return;
        const sortBy = els.sort.value;
        const domain = rootDomain;

        if (!force) {
            const cached = readCache(domain, sortBy);
            if (cached) {
                state.items = cached.items;
                state.channelLabel = cached.channelLabel || '';
                state.error = null;
                state.fromCache = true;
                renderAll();
                return;
            }
        }

        state.loading = true;
        state.error = null;
        state.fromCache = false;
        renderAll();

        try {
            const res = await fetchScripts(domain, sortBy);
            state.items = res.items;
            state.channelLabel = res.channel.label;
            state.error = null;
            writeCache(domain, sortBy, res.items, res.channel.label);
        } catch (e) {
            state.items = [];
            state.error = e;
            state.channelLabel = '';
            console.error(LOG, '全部线路失败', e);
        } finally {
            state.loading = false;
            renderAll();
        }
    }

    /* ============================ 拖拽 ============================ */

    function makeDraggable(element, onDrop) {
        let dragging = false, moved = false, frame = null;
        let startX = 0, startY = 0, originLeft = 0, originTop = 0, dx = 0, dy = 0;

        function point(e) {
            return e.type.indexOf('touch') === 0 ? e.touches[0] : e;
        }

        function dragStart(e) {
            if (e.button === 2) return;
            moved = false;
            const p = point(e);
            startX = p.clientX;
            startY = p.clientY;
            const rect = element.getBoundingClientRect();
            originLeft = rect.left;
            originTop = rect.top;
            element.style.left = `${originLeft}px`;
            element.style.top = `${originTop}px`;
            element.style.right = 'auto';
            element.style.bottom = 'auto';
            element.style.transition = 'none';
            element.classList.add('is-dragging');
            dragging = true;
            if (e.type === 'mousedown') e.preventDefault();
        }

        function drag(e) {
            if (!dragging) return;
            e.preventDefault();
            const p = point(e);
            dx = (p.clientX - startX) * DRAG_SENSITIVITY;
            dy = (p.clientY - startY) * DRAG_SENSITIVITY;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
            if (!frame) {
                frame = requestAnimationFrame(() => {
                    element.style.transform = `translate(${dx}px, ${dy}px)`;
                    frame = null;
                });
            }
        }

        function dragEnd() {
            if (!dragging) return;
            dragging = false;
            if (frame) { cancelAnimationFrame(frame); frame = null; }
            const rect = element.getBoundingClientRect();
            element.style.transform = '';
            element.style.transition = '';
            element.classList.remove('is-dragging');

            const vw = window.innerWidth, vh = window.innerHeight;
            const pos = { top: 'auto', right: 'auto', bottom: 'auto', left: 'auto' };
            const left = rect.left, top = rect.top;

            if (vw - (left + rect.width) < left) pos.right = Math.max(EDGE, vw - (left + rect.width));
            else pos.left = Math.max(EDGE, left);

            if (vh - (top + rect.height) < top) pos.bottom = Math.max(EDGE, vh - (top + rect.height));
            else pos.top = Math.max(EDGE, top);

            applyPosition(element, pos);
            element.classList.add('position-saved');
            setTimeout(() => element.classList.remove('position-saved'), 500);

            if (onDrop) onDrop(pos);
        }

        element.addEventListener('touchstart', dragStart, { passive: false });
        element.addEventListener('mousedown', dragStart);
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('mousemove', drag);
        document.addEventListener('touchend', dragEnd);
        document.addEventListener('mouseup', dragEnd);

        return { wasDragged: () => moved };
    }

    /* ============================ 菜单 ============================ */

    function resetButtonPosition() {
        if (!els) return;
        applyPosition(els.toggle, normalizePosition(DEFAULT_POSITION));
        els.toggle.style.transform = 'none';
        save('button_position', DEFAULT_POSITION);
        els.toggle.classList.add('position-saved');
        setTimeout(() => els.toggle.classList.remove('position-saved'), 500);
    }

    function showContextMenu(x, y) {
        const old = document.querySelector('.uf-menu');
        if (old) old.remove();

        const menu = document.createElement('div');
        menu.className = 'uf-menu';

        const addSep = () => {
            const sep = document.createElement('div');
            sep.className = 'uf-menu-sep';
            menu.appendChild(sep);
        };
        const addRow = (label, onClick, opts) => {
            const o = opts || {};
            const row = document.createElement('div');
            row.className = 'uf-menu-item' + (o.active ? ' is-active' : '');
            const check = document.createElement('span');
            check.className = 'uf-menu-check';
            check.textContent = o.active ? '✓' : '';
            const text = document.createElement('span');
            text.textContent = label;
            row.appendChild(check);
            row.appendChild(text);
            if (o.note) {
                const note = document.createElement('span');
                note.className = 'uf-menu-sub';
                note.textContent = o.note;
                row.appendChild(note);
            }
            row.addEventListener('click', () => { menu.remove(); onClick(); });
            menu.appendChild(row);
        };

        addRow('打开脚本查找器', () => openPanel());
        addSep();
        addRow('重新获取（忽略缓存）', () => refresh(true));

        // —— 线路：默认只显示一行，点开才展开全部线路 ——
        addSep();
        const lock = store('channel_lock', '');
        const working = store('working_channel', '');
        const currentLine = lock
            ? `指定 · ${channelLabelOf(lock)}`
            : (working ? `自动 · ${channelLabelOf(working)}` : '自动');

        const sub = document.createElement('div');
        sub.className = 'uf-submenu';
        const arrow = document.createElement('span');
        arrow.className = 'uf-menu-arrow';
        arrow.textContent = '›';

        const toggleRow = document.createElement('div');
        toggleRow.className = 'uf-menu-item';
        toggleRow.id = 'uf-menu-channel';
        const toggleCheck = document.createElement('span');
        toggleCheck.className = 'uf-menu-check';
        const toggleText = document.createElement('span');
        toggleText.textContent = '切换线路…';
        const toggleNote = document.createElement('span');
        toggleNote.className = 'uf-menu-sub';
        toggleNote.textContent = currentLine;
        toggleRow.appendChild(toggleCheck);
        toggleRow.appendChild(toggleText);
        toggleRow.appendChild(toggleNote);
        toggleRow.appendChild(arrow);
        toggleRow.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = sub.classList.toggle('open');
            toggleRow.classList.toggle('is-open', open);
            arrow.textContent = open ? '⌄' : '›';
            reposition();
        });
        menu.appendChild(toggleRow);

        const addSubRow = (label, onClick, active) => {
            const row = document.createElement('div');
            row.className = 'uf-menu-item uf-submenu-item' + (active ? ' is-active' : '');
            const check = document.createElement('span');
            check.className = 'uf-menu-check';
            check.textContent = active ? '✓' : '';
            const text = document.createElement('span');
            text.textContent = label;
            row.appendChild(check);
            row.appendChild(text);
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.remove();
                onClick();
            });
            sub.appendChild(row);
            return row;
        };

        addSubRow('自动（按顺序探测，推荐）', () => selectChannel(''), !lock);
        allChannels().forEach((c) => {
            addSubRow(
                c.label + (working === c.id && lock !== c.id ? '（上次成功）' : ''),
                () => selectChannel(c.id),
                lock === c.id
            );
        });
        addSubRow('设置自定义中转前缀…', () => configureRelay(), false);
        menu.appendChild(sub);

        addSep();
        addRow('最小化 / 恢复图标', () => els.toggle.classList.toggle('minimized'));
        addRow('重置按钮位置', () => resetButtonPosition());
        addRow('暂时隐藏 30 秒', () => {
            els.toggle.classList.add('hidden');
            setTimeout(() => els.toggle.classList.remove('hidden'), 30000);
        });

        document.body.appendChild(menu);

        const reposition = () => {
            const rect = menu.getBoundingClientRect();
            menu.style.left = `${Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE))}px`;
            menu.style.top = `${Math.max(EDGE, Math.min(y, window.innerHeight - rect.height - EDGE))}px`;
        };
        reposition();

        const close = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.remove();
                document.removeEventListener('click', close, true);
                document.removeEventListener('contextmenu', close, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', close, true);
            document.addEventListener('contextmenu', close, true);
        }, 0);
    }

    function channelLabelOf(id) {
        const c = allChannels().filter((x) => x.id === id)[0];
        return c ? c.label : id;
    }

    /** 清掉当前域名的全部线路缓存（不同排序各有键，逐个删） */
    function clearDomainCache() {
        Object.keys(SORT_OPTIONS).forEach((s) => save(cacheKey(rootDomain, s), null));
    }

    /**
     * 手动指定线路。id 为空字符串表示回到「自动」。
     * 手动指定后不会再自动回退 —— 用户点名要哪条就只用哪条，失败会直接报出来。
     */
    function selectChannel(id) {
        save('channel_lock', id);
        clearDomainCache();
        if (id) {
            save('working_channel', id);
            console.log(LOG, `线路已锁定为「${channelLabelOf(id)}」，不再自动回退`);
        } else {
            console.log(LOG, '线路已恢复为自动选择');
        }
        if (els && els.loaded) refresh(true);
    }

    function configureRelay() {
        const current = store('custom_relay', '');
        const input = window.prompt(
            '自定义中转前缀。会把 GreasyFork 原始地址直接拼在它后面。\n'
            + '例如：https://r.jina.ai/  或  你的自建服务 https://your-proxy/?url=\n'
            + '留空表示不使用自定义中转。',
            current || ''
        );
        if (input === null) return;
        save('custom_relay', input.trim());
        console.log(LOG, '自定义中转已更新：', input.trim() || '(已清空)');
        // 自定义线路消失时，把指向它的锁定一并解除
        if (!input.trim() && store('channel_lock', '') === 'custom') save('channel_lock', '');
        clearDomainCache();
        if (els && els.loaded) refresh(true);
    }

    /* ============================ 面板 ============================ */

    function openPanel() {
        if (!els) return;
        els.container.classList.add('show');
        els.toggle.classList.add('hidden');
        if (!els.loaded) {
            els.loaded = true;
            refresh(false);
        } else if (state.error) {
            // 上一次打开是失败的，不要把它当成「已经加载过」就永远卡在错误页
            refresh(true);
        }
    }

    function closePanel() {
        if (!els) return;
        els.container.classList.remove('show');
        setTimeout(() => els.toggle.classList.remove('hidden'), ANIMATION_DURATION);
    }

    function createUI() {
        if (!document.body) return;
        if (document.getElementById('uf-container')) return;

        injectStyles();

        const container = document.createElement('div');
        container.id = 'uf-container';
        container.innerHTML = `
            <div id="uf-header">
                <div id="uf-header-top">
                    <h3 id="uf-title">脚本查找器</h3>
                    <button id="uf-close" title="关闭">×</button>
                </div>
                <div class="uf-row">
                    <input id="uf-search" type="search" placeholder="在结果中搜索…">
                    <button class="uf-btn" id="uf-refresh" title="忽略缓存重新获取">刷新</button>
                </div>
                <div class="uf-row" style="padding-bottom:8px">
                    <label for="uf-sort">排序</label>
                    <select class="uf-select" id="uf-sort"></select>
                    <label for="uf-limit">条数</label>
                    <select class="uf-select" id="uf-limit"></select>
                    <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
                        <input type="checkbox" id="uf-recent"> 仅看近一年
                    </label>
                </div>
            </div>
            <div id="uf-status"></div>
            <div id="uf-content"></div>
        `;
        document.body.appendChild(container);

        const toggle = document.createElement('button');
        toggle.id = 'uf-toggle';
        toggle.textContent = '🔍';
        toggle.title = '查找可用脚本（左键打开 / 右键菜单 / 双击最小化 / 按住拖动）';
        document.body.appendChild(toggle);

        els = {
            container,
            toggle,
            title: container.querySelector('#uf-title'),
            status: container.querySelector('#uf-status'),
            content: container.querySelector('#uf-content'),
            search: container.querySelector('#uf-search'),
            sort: container.querySelector('#uf-sort'),
            limit: container.querySelector('#uf-limit'),
            recent: container.querySelector('#uf-recent'),
            loaded: false,
        };

        Object.entries(SORT_OPTIONS).forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = t;
            els.sort.appendChild(o);
        });
        els.sort.value = store('sort_preference', DEFAULT_SORT);
        if (!SORT_OPTIONS[els.sort.value]) els.sort.value = DEFAULT_SORT;

        Object.entries(LIMIT_OPTIONS).forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = t;
            els.limit.appendChild(o);
        });
        els.limit.value = String(store('limit_preference', DEFAULT_LIMIT));
        if (!LIMIT_OPTIONS[els.limit.value]) els.limit.value = DEFAULT_LIMIT;

        els.recent.checked = !!store('recent_only', false);

        // 位置：先校验再应用，杜绝「按钮在屏幕外且无法恢复」
        const pos = loadPosition();
        applyPosition(toggle, pos);

        const draggable = makeDraggable(toggle, (newPos) => save('button_position', newPos));

        window.addEventListener('resize', () => {
            const cur = normalizePosition(store('button_position', DEFAULT_POSITION));
            if (!isPositionVisible(cur)) {
                applyPosition(toggle, clampPosition(cur));
                save('button_position', clampPosition(cur));
            }
        });

        toggle.addEventListener('click', () => {
            if (draggable.wasDragged()) return;
            openPanel();
        });

        toggle.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggle.classList.toggle('minimized');
        });

        toggle.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const r = toggle.getBoundingClientRect();
            showContextMenu(r.right + 8, r.top);
        });

        container.querySelector('#uf-close').addEventListener('click', closePanel);

        container.querySelector('#uf-refresh').addEventListener('click', () => refresh(true));

        els.sort.addEventListener('change', () => {
            save('sort_preference', els.sort.value);
            refresh(false);
        });

        els.limit.addEventListener('change', () => {
            save('limit_preference', els.limit.value);
            renderAll();
        });

        els.recent.addEventListener('change', () => {
            save('recent_only', els.recent.checked);
            renderAll();
        });

        els.search.addEventListener('input', renderAll);

        document.addEventListener('keydown', (e) => {
            if (e.altKey && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                if (container.classList.contains('show')) closePanel();
                else openPanel();
            } else if (e.key === 'Escape' && container.classList.contains('show')) {
                closePanel();
            }
        });

        // 油猴菜单兜底：即使按钮被任何原因隐藏，也能从这里打开、选线路或重置
        try {
            GM_registerMenuCommand('打开脚本查找器', openPanel);
            GM_registerMenuCommand('重新获取脚本列表', () => refresh(true));
            GM_registerMenuCommand('线路：自动（推荐）', () => selectChannel(''));
            allChannels().forEach((c) => {
                GM_registerMenuCommand('线路：' + c.label, () => selectChannel(c.id));
            });
            GM_registerMenuCommand('重置悬浮按钮位置', resetButtonPosition);
        } catch (e) {
            console.warn(LOG, '注册油猴菜单失败', e);
        }

        console.log(LOG, `已就绪：${fullHostname}（根域名 ${rootDomain}）`);
    }

    /* ============================ 启动 ============================ */

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI, { once: true });
    } else {
        createUI();
    }
})();
