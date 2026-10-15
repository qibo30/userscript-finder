import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const SCRIPT = readFileSync(new URL('../userscript-finder.user.js', import.meta.url), 'utf8');
const REAL = readFileSync(new URL('./fixtures/bysite.html', import.meta.url), 'utf8');

/* A by-site page where the first item is the ad and the second carries an XSS payload
   in both the title attribute and the description element. */
const XSS_PAGE = `<!DOCTYPE html><html><body>
<ol id="browse-script-list" class="script-list">
  <li class="ad-entry"><div class="ad">advert</div></li>
  <li data-script-id="1" data-script-name="&lt;img src=x onerror=alert(1)&gt;evil"
      data-script-authors="{&quot;1&quot;:&quot;&lt;b&gt;bad&lt;/b&gt;&quot;}"
      data-script-daily-installs="7" data-script-total-installs="1234"
      data-script-rating-score="55" data-script-updated-date="2026-01-01">
    <h2><a class="script-link" href="/zh-CN/scripts/1-evil">x</a></h2>
    <span class="script-description description">&lt;script&gt;window.__PWNED__=1&lt;/script&gt;desc</span>
  </li>
</ol></body></html>`;

function makeDom(pageUrl, mem) {
    const store = Object.assign({}, mem);
    const log = [];
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: pageUrl, runScripts: 'dangerously', pretendToBeVisual: true,
    });
    const { window } = dom;
    window.console = console;
    window.GM_getValue = (k, d) => (k in store ? store[k] : d);
    window.GM_setValue = (k, v) => { store[k] = v; };
    window.GM_addStyle = () => {};
    window.GM_registerMenuCommand = () => {};
    window.GM_xmlhttpRequest = (o) => {
        log.push(o.url);
        const body = /greasyfork\.org/.test(o.url) && !/r\.jina\.ai/.test(o.url) ? null : XSS_PAGE;
        queueMicrotask(() => {
            if (body === null) o.onerror && o.onerror(new Error('blocked'));
            else o.onload && o.onload({ status: 200, responseText: body });
        });
    };
    const el = window.document.createElement('script');
    el.textContent = SCRIPT;
    window.document.body.appendChild(el);
    return { dom, window, store, log };
}

const results = [];

/* --- A. ad-entry skipped + XSS payload neutralised --- */
{
    const { dom, window } = makeDom('https://www.bilibili.com/x', {});
    await new Promise((r) => setTimeout(r, 50));
    window.document.getElementById('uf-toggle').click();
    await new Promise((r) => setTimeout(r, 800));
    const d = window.document;
    const titleA = d.querySelector('#uf-content .uf-item-title a');
    results.push({
        scenario: 'A: ad skipped + XSS neutralised',
        items: d.querySelectorAll('#uf-content .uf-item').length,
        expect_items: 1,
        injected_img_nodes: d.querySelectorAll('#uf-content img').length,
        injected_script_nodes: d.querySelectorAll('#uf-content script').length,
        pwned: !!window.__PWNED__,
        title_is_literal_text: titleA ? titleA.textContent : null,
        title_child_elements: titleA ? titleA.children.length : null,
        desc_is_literal_text: d.querySelector('#uf-content .uf-desc')?.textContent || null,
        author_is_literal_text: d.querySelector('#uf-content .uf-meta')?.textContent || null,
        first_href: titleA ? titleA.getAttribute('href') : null,
    });
    dom.window.close();
}

/* --- B. real page: every rendered item must have a greasyfork.org link, no 'Untitled' --- */
{
    const store = {};
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://www.bilibili.com/x', runScripts: 'dangerously', pretendToBeVisual: true,
    });
    const { window } = dom;
    window.console = console;
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
    window.document.getElementById('uf-toggle').click();
    await new Promise((r) => setTimeout(r, 1500));
    const d = window.document;
    const links = Array.from(d.querySelectorAll('#uf-content .uf-item-title a'));
    results.push({
        scenario: 'B: real page 100 items, all links valid',
        items: links.length,
        all_greasyfork_links: links.every((a) => a.getAttribute('href').startsWith('https://greasyfork.org/')),
        any_untitled: links.some((a) => /Untitled/i.test(a.textContent)),
        any_empty_title: links.some((a) => !a.textContent.trim()),
        all_have_meta: Array.from(d.querySelectorAll('#uf-content .uf-meta')).every((m) => m.textContent.trim().length > 0),
        limit_select: d.getElementById('uf-limit').value,
        sort_select: d.getElementById('uf-sort').value,
        search_filter_works: (() => {
            const inp = d.getElementById('uf-search');
            inp.value = '工具箱';
            inp.dispatchEvent(new window.Event('input', { bubbles: true }));
            const n = d.querySelectorAll('#uf-content .uf-item').length;
            inp.value = '';
            inp.dispatchEvent(new window.Event('input', { bubbles: true }));
            return { filtered: n, restored: d.querySelectorAll('#uf-content .uf-item').length };
        })(),
        recent_only_filter: (() => {
            const cb = d.getElementById('uf-recent');
            cb.checked = true;
            cb.dispatchEvent(new window.Event('change', { bubbles: true }));
            const n = d.querySelectorAll('#uf-content .uf-item').length;
            cb.checked = false;
            cb.dispatchEvent(new window.Event('change', { bubbles: true }));
            return { with_recent_only: n, without: d.querySelectorAll('#uf-content .uf-item').length };
        })(),
    });
    dom.window.close();
}

/* --- C. error then reopen must retry (not stay stuck) --- */
{
    const store = {};
    let allowSuccess = false;
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        url: 'https://www.bilibili.com/x', runScripts: 'dangerously', pretendToBeVisual: true,
    });
    const { window } = dom;
    window.console = console;
    window.GM_getValue = (k, d) => (k in store ? store[k] : d);
    window.GM_setValue = (k, v) => { store[k] = v; };
    window.GM_addStyle = () => {};
    window.GM_registerMenuCommand = () => {};
    window.GM_xmlhttpRequest = (o) => {
        const body = allowSuccess && /r\.jina\.ai/.test(o.url) ? REAL : null;
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
    await new Promise((r) => setTimeout(r, 600));
    const afterFirstOpen = {
        has_error_state: !!d.querySelector('#uf-content .uf-state'),
        retry_button: !!d.querySelector('#uf-retry'),
        items: d.querySelectorAll('#uf-content .uf-item').length,
    };

    d.getElementById('uf-close').click();
    await new Promise((r) => setTimeout(r, 400));
    allowSuccess = true;
    d.getElementById('uf-toggle').click();
    await new Promise((r) => setTimeout(r, 1500));
    const afterReopen = {
        items: d.querySelectorAll('#uf-content .uf-item').length,
        has_error_state: !!d.querySelector('#uf-content .uf-state'),
    };

    /* explicit retry button path */
    allowSuccess = false;
    d.getElementById('uf-close').click();
    await new Promise((r) => setTimeout(r, 400));
    d.getElementById('uf-toggle').click();
    await new Promise((r) => setTimeout(r, 600));
    const btn = d.querySelector('#uf-retry');
    allowSuccess = true;
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 1500));

    results.push({
        scenario: 'C: error -> close -> reopen retries; retry button works',
        afterFirstOpen,
        afterReopen,
        afterRetryButton: { items: d.querySelectorAll('#uf-content .uf-item').length },
    });
    dom.window.close();
}

console.log(JSON.stringify(results, null, 2));
