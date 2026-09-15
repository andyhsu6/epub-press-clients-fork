// End-to-end check in a real browser: load the unpacked MV3 extension into
// headless Brave, open the TOC fixtures as tabs, drive the real popup UI, and
// inspect the .epub that the bundled code actually produces.
//
//   node tools/toc-e2e.mjs [fixture ...]        (defaults to all three)
//   TOC_E2E_HEADED=1 ...                        (if headless refuses extensions)
//   TOC_E2E_PORT=9225
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(PKG, 'app');
const FIXDIR = join(PKG, 'tests', 'fixtures', 'toc');
const OUT = join(PKG, '..', '..', '.omo', 'toc-e2e');
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const HTTP_PORT = 8901;
const CDP_PORT = Number(process.env.TOC_E2E_PORT) || 9225;
const HEADLESS = process.env.TOC_E2E_HEADED !== '1';

const ONE_PER_BOOK = process.argv.includes('--one-per-book');
const DEFAULT_FIXTURES = ['ibbs-forum-13chapters.html', 'uaa-reader-h1.html', 'long-title-lines.html', 'multi-heading.html', 'standalone-p-titles.html'];
const fixtures = process.argv.filter((a) => a.endsWith('.html'));
if (!fixtures.length) fixtures.push(...DEFAULT_FIXTURES);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(400);
  }
}

function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const sessions = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Target.attachedToTarget') sessions.set(m.params.targetInfo.targetId, m.params.sessionId);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    ws.onerror = reject;
    ws.onopen = () => {
      const raw = (method, params = {}, sessionId) => new Promise((r) => {
        const n = ++id;
        pending.set(n, r);
        ws.send(JSON.stringify({ id: n, method, params, sessionId }));
      });
      const forTarget = (targetId) => {
        const sid = sessions.get(targetId);
        return async (method, params = {}) => {
          const r = await raw(method, params, sid);
          if (r.error) throw new Error(`${method}: ${r.error.message}`);
          return r.result;
        };
      };
      resolve({
        raw,
        sessions,
        async open(url) {
          const t = (await raw('Target.createTarget', { url })).result.targetId;
          await raw('Target.attachToTarget', { targetId: t, flatten: true });
          const send = forTarget(t);
          await send('Page.enable');
          await send('Runtime.enable');
          return { targetId: t, send, evaluate: async (expression) => {
            const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400));
            return r.result.value;
          } };
        },
        closePage: (targetId) => raw('Target.closeTarget', { targetId }),
        list: () => raw('Target.getTargets').then((r) => r.result.targetInfos),
      });
    };
  });
}

const server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--directory', FIXDIR],
  { stdio: 'ignore' });
const brave = spawn(BRAVE, [
  ...(HEADLESS ? ['--headless=new'] : []),
  '--disable-gpu', '--no-sandbox', '--fingerprinting-protection=0',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=/tmp/brave-e2e-profile`,
  `--disable-extensions-except=${APP}`, `--load-extension=${APP}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
brave.stderr.on('data', (d) => { stderr += d.toString(); });

mkdirSync(OUT, { recursive: true });
let exitCode = 0;
try {
  const wsUrl = (await waitFor(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { return null; }
  }, 30000, 'CDP endpoint'));
  const cdp = await cdpClient(wsUrl);

  const extId = await waitFor(async () => {
    const infos = await cdp.list();
    const t = infos.find((i) => i.url.startsWith('chrome-extension://'));
    return t ? new URL(t.url).host : null;
  }, 20000, 'extension to register').catch((e) => {
    console.error('No extension target appeared.', HEADLESS
      ? 'headless Brave may refuse --load-extension; retry with TOC_E2E_HEADED=1'
      : 'Brave shields may have blocked it.');
    throw e;
  });
  console.log('[e2e] extension id:', extId);

  const runs = ONE_PER_BOOK ? fixtures.map((f) => [f]) : [fixtures];
  for (const group of runs) {
    console.log(`\n########## book from: ${group.join(' + ')}`);
    const pages = [];
    for (const f of group) pages.push(await cdp.open(`http://127.0.0.1:${HTTP_PORT}/${f}`));
    await sleep(2000);

    const popup = await cdp.open(`chrome-extension://${extId}/popup.html`);
    const boxes = await waitFor(async () => {
      const n = await popup.evaluate('document.querySelectorAll(".article-checkbox").length');
      return n === group.length ? n : null;
    }, 20000, `popup to list ${group.length} tab(s)`);
    console.log('[e2e] tab checkboxes:', boxes);

    const dataUrl = await popup.evaluate(`(async () => {
      document.querySelectorAll('.article-checkbox').forEach((c) => { c.checked = true; });
      const sel = document.querySelector('#book-format');
      sel.value = 'epub';
      sel.dispatchEvent(new Event('change'));
      const capture = new Promise((resolve) => {
        chrome.downloads.download = (opts, cb) => { resolve(opts); if (cb) cb(1); return 1; };
        setTimeout(() => resolve(null), 120000);
      });
      document.querySelector('#download').click();
      const opts = await capture;
      return opts ? { filename: opts.filename, url: opts.url } : null;
    })()`);
    if (!dataUrl) throw new Error('popup never called chrome.downloads.download');
    console.log('[e2e] download requested as:', dataUrl.filename);

    const buf = Buffer.from(dataUrl.url.split(',')[1], 'base64');
    const label = group.map((f) => basename(f, '.html')).join('+');
    writeFileSync(join(OUT, `${label}.epub`), buf);
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).sort();
    console.log('[e2e] parts:', names.filter((n) => !n.endsWith('/')).join(' '));

    const ncx = await zip.file('OEBPS/toc.ncx').async('string');
    console.log(ncx.slice(ncx.indexOf('<navMap>'), ncx.indexOf('</navMap>') + 9).replace(/\n {8}/g, '\n  '));

    const parts = {};
    for (const n of names.filter((x) => x.endsWith('.xhtml'))) parts[n] = await zip.file(n).async('string');
    const deadParts = Object.entries(parts).filter(([, xml]) => /parsererror/.test(xml)).map(([n]) => n);
    const links = [...ncx.matchAll(/<content src="([^"#]+)#([^"]+)"\/>/g)];
    const dead = links.filter((m) => !(parts[`OEBPS/${m[1]}`] || '').includes(`id="${m[2]}"`))
      .map((m) => `${m[1]}#${m[2]}`);
    const depth = (ncx.match(/dtb:depth" content="(\d+)"/) || [])[1];
    console.log('[e2e] dtb:depth =', depth,
      '| navPoints =', (ncx.match(/<navPoint/g) || []).length,
      '| fragment links =', links.length, '| dead =', dead.length ? dead.join(',') : 'none',
      '| parsererror =', deadParts.length ? deadParts.join(',') : 'none');
    await cdp.closePage(popup.targetId).catch(() => {});
    for (const p of pages) await cdp.closePage(p.targetId).catch(() => {});
  }
} catch (err) {
  exitCode = 1;
  console.error('[e2e] FAILED:', err.message);
  if (stderr) console.error('[brave stderr tail]', stderr.slice(-600));
} finally {
  brave.kill();
  server.kill();
  setTimeout(() => process.exit(exitCode), 500);
}
