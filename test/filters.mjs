import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const SCRIPT = readFileSync(new URL('../userscript-finder.user.js', import.meta.url), 'utf8');
const REAL = readFileSync(new URL('./fixtures/bysite.html', import.meta.url), 'utf8');

const store = {};
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://www.bilibili.com/x', runScripts: 'dangerously', pretendToBeVisual: true,
});
const { window } = dom;
window.console = { log() {}, warn() {}, error() {} };
window.GM_getValue = (k, d) => (k in store ? store[k] : d);
window.GM_setValue = (k, v) => { store[k] = v; };
window.GM_addStyle = () => {};
window.GM_registerMenuCommand = () => {};
window.GM_xmlhttpRequest = (o) => {
    const body = /r\.jina\.ai/.test(o.url) ? REAL : null;
    queueMicrotask(() => body === null
        ? o.onerror(new Error('blocked'))
        : o.onload({ status: 200, responseText: body }));
};
const el = window.document.createElement('script');
el.textContent = SCRIPT;
window.document.body.appendChild(el);
await new Promise((r) => setTimeout(r, 50));

const d = window.document;
d.getElementById('uf-toggle').click();
await new Promise((r) => setTimeout(r, 1200));

const count = () => d.querySelectorAll('#uf-content .uf-item').length;
const setLimit = (v) => {
    const s = d.getElementById('uf-limit');
    s.value = v;
    s.dispatchEvent(new window.Event('change', { bubbles: true }));
};
const setRecent = (v) => {
    const c = d.getElementById('uf-recent');
    c.checked = v;
    c.dispatchEvent(new window.Event('change', { bubbles: true }));
};

const out = {};
out.limit_50 = count();
setLimit('20'); out.limit_20 = count();
setLimit('100'); out.limit_100 = count();
setLimit('0'); out.limit_all = count();
setRecent(true); out.all_recent_only = count();
setLimit('50'); out.recent_only_50 = count();
setRecent(false); out.all_50 = count();

/* sorting re-request check */
const sortSel = d.getElementById('uf-sort');
const before = store['cache_v6::bilibili.com::total_installs'] ? 'cached' : 'uncached';
sortSel.value = 'updated';
sortSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await new Promise((r) => setTimeout(r, 1200));
out.sort_change = { before, after_items: count(), cache_key_for_updated: !!store['cache_v6::bilibili.com::updated'] };

/* cache reuse: reopening must not re-request */
const reqsBefore = Object.keys(store).filter((k) => k.startsWith('cache_v6')).length;
d.getElementById('uf-close').click();
await new Promise((r) => setTimeout(r, 400));
d.getElementById('uf-toggle').click();
await new Promise((r) => setTimeout(r, 600));
out.reopen_uses_cache = { items: count(), cache_keys: reqsBefore };

/* status line reflects the cache */
out.status_text = d.getElementById('uf-status').textContent.trim();

console.log(JSON.stringify(out, null, 2));
