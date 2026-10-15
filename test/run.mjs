import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const SCRIPT = readFileSync(new URL('../userscript-finder.user.js', import.meta.url), 'utf8');
const FIXTURE_LIST = readFileSync(new URL('./fixtures/bysite.html', import.meta.url), 'utf8');          // real by-site page (100 items)
const FIXTURE_EMPTY = readFileSync(new URL('./fixtures/empty.html', import.meta.url), 'utf8'); // real "no scripts" page

/* ------------------------------------------------------------------ */
/* GM shim                                                             */
/* ------------------------------------------------------------------ */

function makeShim({ mem = {}, mode = 'real', log = [] }) {
    const store = Object.assign({}, mem);

    const GM = {
        GM_getValue: (k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
        GM_setValue: (k, v) => { store[k] = v; },
        GM_addStyle: () => {},
        GM_registerMenuCommand: () => {},
        GM_xmlhttpRequest: (opts) => {
            const url = opts.url;
            log.push(url);

            const respond = (status, body) => {
                queueMicrotask(() => {
                    if (status === 0) opts.onerror && opts.onerror(new Error('network'));
                    else if (status === -1) opts.ontimeout && opts.ontimeout(new Error('timeout'));
                    else opts.onload && opts.onload({ status, responseText: body, responseHeaders: '' });
                });
            };

            if (mode === 'offline') {
                // every channel fails at the socket level
                return respond(0);
            }

            if (mode === 'fixture') {
                if (url.startsWith('https://greasyfork.org/')) return respond(0);          // direct blocked
                if (url.startsWith('https://r.jina.ai/')) {
                    const isEmpty = /zzz-nonexistent/.test(url);
                    return respond(200, isEmpty ? FIXTURE_EMPTY : FIXTURE_LIST);
                }
                return respond(404, '');
            }

            // mode === 'real': hit the network through the system proxy
            const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} respond(-1); }, opts.timeout || 20000);
            const ctrl = new AbortController();
            fetch(url, { headers: opts.headers || {}, signal: ctrl.signal, redirect: 'follow' })
                .then(async (r) => {
                    clearTimeout(t);
                    respond(r.status, await r.text());
                })
                .catch(() => { clearTimeout(t); respond(0); });
        },
    };
    return { GM, store };
}

/* ------------------------------------------------------------------ */
/* Runner                                                             */
/* ------------------------------------------------------------------ */

async function run(name, { mem = {}, mode = 'fixture', openPanel = true, waitMs = 1500, pageUrl = 'https://www.bilibili.com/video/BV1xx' }) {
    const log = [];
    const { GM, store } = makeShim({ mem, mode, log });

    const dom = new JSDOM(
        `<!DOCTYPE html><html><body><div id="probe">probe</div></body></html>`,
        { url: pageUrl, runScripts: 'dangerously', pretendToBeVisual: true }
    );
    const { window } = dom;
    Object.assign(window, GM);
    window.console = console;

    // inject the userscript after the shim exists
    const el = window.document.createElement('script');
    el.textContent = SCRIPT;
    window.document.body.appendChild(el);

    // jsdom is still 'loading' here, so the script defers createUI to DOMContentLoaded
    await new Promise((resolve) => {
        if (window.document.readyState === 'loading') {
            window.document.addEventListener('DOMContentLoaded', resolve, { once: true });
        } else resolve();
    });
    await new Promise((r) => setTimeout(r, 50));

    if (openPanel) {
        window.document.getElementById('uf-toggle').click();
    }
    await new Promise((r) => setTimeout(r, waitMs));

    const d = window.document;
    const out = {
        scenario: name,
        toggle: !!d.getElementById('uf-toggle'),
        panel_shown: d.getElementById('uf-container').classList.contains('show'),
        status: (d.getElementById('uf-status') || {}).textContent?.trim() || null,
        items: d.querySelectorAll('#uf-content .uf-item').length,
        state: d.querySelectorAll('#uf-content .uf-state').length,
        state_text: (d.getElementById('uf-content') || {}).textContent?.trim().slice(0, 160) || null,
        first_title: d.querySelector('#uf-content .uf-item-title a')?.textContent || null,
        first_meta: d.querySelector('#uf-content .uf-meta')?.textContent || null,
        untitled_leak: Array.from(d.querySelectorAll('#uf-content .uf-item-title a')).some((a) => /Untitled/i.test(a.textContent)),
        retry_button: !!d.querySelector('#uf-retry'),
        urls: log,
        toggle_style: (() => {
            const t = d.getElementById('uf-toggle');
            return t ? { top: t.style.top, right: t.style.right, bottom: t.style.bottom, left: t.style.left } : null;
        })(),
        stored_position: store['button_position'],
        stored_channel: store['working_channel'],
        xss_probe: !!d.querySelector('#uf-content script'),
    };
    dom.window.close();
    return out;
}

const results = [];

/* 1. real network through the proxy: direct blocked -> jina fallback -> items */
results.push(await run('REAL network (proxy), expect jina fallback + items', { mode: 'real', waitMs: 45000 }));

/* 2. deterministic fixture: fallback parse + render */
results.push(await run('FIXTURE list, expect 50 items rendered (default limit)', { mode: 'fixture' }));

/* 3. every channel fails -> error state, NOT "no scripts" */
results.push(await run('OFFLINE, expect error state + retry, never "no scripts"', { mode: 'offline' }));

/* 4. genuinely empty domain -> "no scripts" state, distinct from error */
results.push(await run('FIXTURE empty domain, expect "no scripts" state', { mode: 'fixture', pageUrl: 'https://zzz-nonexistent-xyz.com/' }));

/* 5. off-screen saved button position must be clamped back into view */
results.push(await run('OFFSCREEN saved position, expect clamp into viewport', {
    mode: 'fixture',
    mem: { button_position: { top: 99999, left: 99999, right: 'auto', bottom: 'auto' } },
    openPanel: false,
    waitMs: 300,
}));

/* 6. daily_installs sort must actually be sent (v5.2 dropped it) */
results.push(await run('daily_installs sort, expect sort=daily_installs in URL', {
    mode: 'fixture',
    mem: { sort_preference: 'daily_installs' },
    waitMs: 1200,
}));

console.log(JSON.stringify(results, null, 2));
