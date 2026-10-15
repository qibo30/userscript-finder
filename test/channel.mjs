import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const SCRIPT = readFileSync(new URL('../userscript-finder.user.js', import.meta.url), 'utf8');
const FIXTURE_LIST = readFileSync(new URL('./fixtures/bysite.html', import.meta.url), 'utf8');

function makeShim({ mem = {}, mode = 'fixture', log = [] }) {
    const store = Object.assign({}, mem);
    const GM = {
        GM_getValue: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
        GM_setValue: (k, v) => { store[k] = v; },
        GM_addStyle: () => {},
        GM_registerMenuCommand: () => {},
        GM_xmlhttpRequest: (opts) => {
            log.push(opts.url);
            const respond = (status, body) => queueMicrotask(() => {
                if (status === 0) opts.onerror && opts.onerror(new Error('network'));
                else opts.onload && opts.onload({ status, responseText: body, responseHeaders: '' });
            });
            if (mode === 'offline') return respond(0);
            if (opts.url.startsWith('https://greasyfork.org/')) return respond(0);
            if (opts.url.startsWith('https://r.jina.ai/')) return respond(200, FIXTURE_LIST);
            return respond(404, '');
        },
    };
    return { GM, store };
}

async function boot({ mem = {}, mode = 'fixture' }) {
    const log = [];
    const { GM, store } = makeShim({ mem, mode, log });
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="probe">p</div></body></html>',
        { url: 'https://www.bilibili.com/video/BV1xx', runScripts: 'dangerously', pretendToBeVisual: true });
    const { window } = dom;
    Object.assign(window, GM);
    window.console = { log() {}, warn() {}, error() {} };
    const el = window.document.createElement('script');
    el.textContent = SCRIPT;
    window.document.body.appendChild(el);
    await new Promise((r) => {
        if (window.document.readyState === 'loading') window.document.addEventListener('DOMContentLoaded', r, { once: true });
        else r();
    });
    await new Promise((r) => setTimeout(r, 50));
    return { window, store, log, dom };
}

const rightClick = (window) => {
    const t = window.document.getElementById('uf-toggle');
    t.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    return window.document.querySelector('.uf-menu');
};
const labelOf = (row) => row.querySelector('span:nth-child(2)').textContent;
/** top-level rows only (excludes the nested channel submenu) */
const topRows = (window) => Array.from(window.document.querySelectorAll('.uf-menu > .uf-menu-item'))
    .map((r) => ({ label: labelOf(r), active: r.classList.contains('is-active'), has_arrow: !!r.querySelector('.uf-menu-arrow') }));
const subOpen = (window) => {
    const s = window.document.querySelector('.uf-submenu');
    return !!s && s.classList.contains('open');
};
const subRows = (window) => Array.from(window.document.querySelectorAll('.uf-submenu .uf-menu-item'))
    .map((r) => ({ label: labelOf(r), active: r.classList.contains('is-active') }));
const openSub = (window) => {
    window.document.getElementById('uf-menu-channel')
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
};
const clickSub = (window, label) => {
    const row = Array.from(window.document.querySelectorAll('.uf-submenu .uf-menu-item'))
        .find((r) => labelOf(r) === label);
    if (!row) throw new Error('no sub row: ' + label + ' / have: '
        + Array.from(window.document.querySelectorAll('.uf-submenu .uf-menu-item')).map(labelOf).join(' | '));
    row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
const status = (window) => (window.document.getElementById('uf-status') || {}).textContent?.trim() || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];

/* 1. menu opens COLLAPSED: channels not visible until 切换线路… is clicked */
{
    const { window, store } = await boot({});
    rightClick(window);
    const collapsed = { top: topRows(window), sub_open: subOpen(window), sub_rows: subRows(window) };
    openSub(window);
    const expanded = { sub_open: subOpen(window), sub_rows: subRows(window), top: topRows(window) };
    results.push({
        scenario: '1. menu collapsed by default, expands on 切换线路…',
        collapsed,
        expanded,
        stored_lock: store['channel_lock'] ?? null,
    });
    window.close();
}

/* 2. the toggle row shows the current channel as its note */
{
    const { window } = await boot({ mem: { working_channel: 'jina' } });
    rightClick(window);
    const row = window.document.getElementById('uf-menu-channel');
    results.push({
        scenario: '2. toggle row note shows current channel',
        note: row.querySelector('.uf-menu-sub').textContent,
        arrow: row.querySelector('.uf-menu-arrow').textContent,
    });
    window.close();
}

/* 3. locked state is reflected in the note and in the submenu check */
{
    const { window } = await boot({ mem: { channel_lock: 'jina' } });
    rightClick(window);
    const note = window.document.getElementById('uf-menu-channel').querySelector('.uf-menu-sub').textContent;
    openSub(window);
    results.push({
        scenario: '3. locked=jina -> note 指定 · Jina 中转, submenu checks jina',
        note,
        sub_rows: subRows(window),
    });
    window.close();
}

/* 4. pick a channel from the submenu -> lock set, only that channel requested */
{
    const { window, store, log } = await boot({});
    window.document.getElementById('uf-toggle').click();
    await sleep(800);
    log.length = 0;
    rightClick(window);
    openSub(window);
    clickSub(window, '官方直连');
    await sleep(800);
    results.push({
        scenario: '4. pick 官方直连 from submenu -> locked, no fallback',
        stored_lock: store['channel_lock'] ?? null,
        urls: log.slice(),
        tried_jina: log.some((u) => u.startsWith('https://r.jina.ai/')),
        status: status(window),
    });
    window.close();
}

/* 5. locked channel fails -> error state + 切回自动 */
{
    const { window, store } = await boot({ mode: 'offline', mem: { channel_lock: 'direct' } });
    window.document.getElementById('uf-toggle').click();
    await sleep(600);
    const d = window.document;
    results.push({
        scenario: '5. locked channel fails -> error + 切回自动',
        state_text: (d.getElementById('uf-content') || {}).textContent?.trim().slice(0, 110) || null,
        retry_button: !!d.querySelector('#uf-retry'),
        unlock_button: !!d.querySelector('#uf-unlock'),
        status: status(window),
        stored_lock: store['channel_lock'],
    });
    window.close();
}

/* 6. 切回自动 resumes fallback */
{
    const { window, store, log } = await boot({ mode: 'fixture', mem: { channel_lock: 'direct' } });
    window.document.getElementById('uf-toggle').click();
    await sleep(600);
    const d = window.document;
    const unlock = d.querySelector('#uf-unlock');
    if (unlock) unlock.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(800);
    results.push({
        scenario: '6. 切回自动 -> fallback resumes',
        stored_lock: store['channel_lock'] ?? null,
        tried_jina: log.some((u) => u.startsWith('https://r.jina.ai/')),
        items: d.querySelectorAll('#uf-content .uf-item').length,
        status: status(window),
    });
    window.close();
}

/* 7. menu 自动 row unlocks */
{
    const { window, store, log } = await boot({ mem: { channel_lock: 'direct' } });
    window.document.getElementById('uf-toggle').click();
    await sleep(800);
    log.length = 0;
    rightClick(window);
    openSub(window);
    clickSub(window, '自动（按顺序探测，推荐）');
    await sleep(800);
    results.push({
        scenario: '7. submenu 自动 unlocks and fallback resumes',
        urls: log.slice(),
        status: status(window),
        items: window.document.querySelectorAll('#uf-content .uf-item').length,
        stored_lock: store['channel_lock'] ?? null,
    });
    window.close();
}

/* 8. custom relay is a selectable submenu row */
{
    const { window, store, log } = await boot({ mem: { custom_relay: 'https://relay.example/?url=' } });
    rightClick(window);
    openSub(window);
    const rows = subRows(window);
    clickSub(window, '自定义中转');
    await sleep(800);
    results.push({
        scenario: '8. custom relay selectable from submenu',
        sub_rows: rows,
        stored_lock: store['channel_lock'] ?? null,
        urls: log.slice(),
    });
    window.close();
}

/* 9. stale custom lock self-heals */
{
    const { window, store, log } = await boot({ mem: { channel_lock: 'custom' } });
    window.document.getElementById('uf-toggle').click();
    await sleep(800);
    results.push({
        scenario: '9. stale custom lock -> self-heals to auto',
        urls: log.slice(),
        status: status(window),
        stored_lock: store['channel_lock'] ?? null,
        items: window.document.querySelectorAll('#uf-content .uf-item').length,
    });
    window.close();
}

/* 10. clicking 切换线路… does NOT close the menu or change the channel */
{
    const { window, store } = await boot({});
    rightClick(window);
    openSub(window);
    const stillThere = !!window.document.querySelector('.uf-menu');
    const menuGone = !!window.document.querySelector('.uf-menu') === false;
    results.push({
        scenario: '10. expanding the submenu keeps the menu open, channel unchanged',
        menu_still_open: stillThere,
        menu_removed: menuGone,
        stored_lock: store['channel_lock'] ?? null,
        sub_open: subOpen(window),
    });
    window.close();
}

console.log(JSON.stringify(results, null, 2));
