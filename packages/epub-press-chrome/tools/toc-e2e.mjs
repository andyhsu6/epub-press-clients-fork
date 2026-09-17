// End-to-end check in a real browser: load the unpacked MV3 extension into
// headless Brave, open the TOC fixtures as tabs, drive the real popup UI, and
// inspect the .epub that the bundled code actually produces.
//
// Default run = the base fixture book plus one book per merged-pagination
// family (pag-page-1, np-page-1); those single-tab books must contain the
// page-2/3 sentinels and exactly two `<!-- pagination-break -->` markers, and
// the popup's #pagination-summary must be non-empty, all read from the real
// DOM and the real produced .epub.
//
// Every book is then held to the outline contract (plan todo 9): toc.ncx's
// navMap and the visible TOC page must describe the SAME tree, counted both
// with raw regex and node by node. The last book of the default run is
// volume-carryover-e2e.html, whose only source of nesting is the volume
// carry-over, so a stale app/build bundle fails there (see VOLUME_FIXTURE).
// That book additionally carries a shape lock (4 parents, child counts
// {76,40,89,6}) — but only when it is a book of its own. Grouped with another
// fixture its outline legitimately contains that fixture's rows too, so the lock
// prints "skipped (book grouped with others)" and the nesting-existence and
// ncx-vs-page assertions still run.
//
//   node tools/toc-e2e.mjs [fixture ...]        (explicit fixtures = one book)
//   node tools/toc-e2e.mjs --one-per-book       (each fixture a book of its own;
//                                                the default expansion ALSO runs
//                                                VOLUME_FIXTURE as its own book)
//   TOC_E2E_HEADED=1 ...                        (if headless refuses extensions)
//   TOC_E2E_PORT=9225
//   TOC_E2E_SKIP_VOLUME=1                       (opt out of the discriminator gate
//                                                below; default: any run whose books
//                                                never include VOLUME_FIXTURE aborts
//                                                BEFORE the browser starts. A run that
//                                                does skip ends with a loud
//                                                "volume discriminator: SKIPPED" banner
//                                                and keeps exit code 0 — it passes, it
//                                                just does not prove the bundle is fresh.)
//   TOC_E2E_VERBOSE=1                           (print the full navMap for every
//                                                book; by default the per-line dump
//                                                is suppressed above 60 navPoints)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Fresh temp profile per run: no state leaks in from a previously loaded
// extension instance. (It follows that this harness structurally CANNOT detect
// a stale already-loaded extension - that is what DEPLOYMENT.md's
// delete-and-re-add discipline is for.)
const PROFILE = mkdtempSync(join(tmpdir(), 'toc-e2e-profile-'));

const ONE_PER_BOOK = process.argv.includes('--one-per-book');
// Deliberate bypass of the zero-coverage gate (see the gate right before the
// browser spawn): without it, any run whose books do not include VOLUME_FIXTURE
// aborts at startup instead of silently "passing" without the discriminator.
const SKIP_VOLUME = process.env.TOC_E2E_SKIP_VOLUME === '1';
const DEFAULT_FIXTURES = ['ibbs-forum-13chapters.html', 'uaa-reader-h1.html', 'long-title-lines.html', 'multi-heading.html', 'standalone-p-titles.html'];
// Merged-pagination families: opening page 1 makes the product's own
// findNextPageUrl walk page 2 and 3 as real HTTP requests against the fixture
// server, and the produced chapter must carry all three sentinels.
const PAGINATED_FAMILIES = [
  { root: 'pag-page-1.html', sentinels: ['PAGE1SENTINEL', 'PAGE2SENTINEL', 'PAGE3SENTINEL'] },
  { root: 'np-page-1.html', sentinels: ['NPSENT1', 'NPSENT2', 'NPSENT3'] },
];
const MERGE_MARKER = '<!-- pagination-break -->';
// The volume carry-over book, kept as a book of its own instead of joining the
// base fixtures. Reason: the base book already nests under the OLD bundle too
// (multi-heading.html ships h1..h6, and buildNavTree/renderTocHtml long predate
// the carry-over), so nesting measured there proves nothing. This fixture is
// 211 sibling <p> chapter labels; only scripts/toc.js splitVolumeEntry can
// group them under 4 volume parents (child counts 76/40/89/6, spanning labels
// 1-76 / 77-116 / 117-205 / 206-211 — same spans as the T7 node suite). Flat
// tree => the bundle in app/build predates the carry-over. That exact shape is
// asserted as a lock in the run loop, so a partially-working carry-over cannot
// pass either.
const VOLUME_FIXTURE = 'volume-carryover-e2e.html';
const fixtures = process.argv.filter((a) => a.endsWith('.html'));
const explicitFixtures = fixtures.length > 0;
if (!fixtures.length) fixtures.push(...DEFAULT_FIXTURES);
console.log('[e2e] profile:', PROFILE);

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

// ─── The outline, read back out of the produced .epub ───────────────────────
// scripts/generater.js renders toc.ncx's navMap AND the visible TOC page from
// one and the same tree (buildNavTree -> renderNavPoints + renderTocHtml), so
// the two cannot legitimately disagree. These readers rebuild each side's tree
// from the zip text and nothing else: they import nothing from scripts/, so
// what they measure is exactly what the loaded app/build bundle wrote.
// Every run group is built from the fixture strings verbatim (CLI arg or the
// constants above), so plain membership is equivalent to the old double
// basename comparison - and stricter: it cannot match a differently named file.
const isVolumeBook = (group) => group.includes(VOLUME_FIXTURE);

function parseNcxNavMap(ncx) {
  const open = ncx.indexOf('<navMap>');
  const close = ncx.indexOf('</navMap>');
  const body = open >= 0 && close > open ? ncx.slice(open + 8, close) : '';
  const root = { text: '(navMap)', src: '', children: [] };
  const stack = [root];
  const re = /<navPoint\b[^>]*>|<\/navPoint>|<navLabel><text>([\s\S]*?)<\/text><\/navLabel>|<content src="([^"]*)"\s*\/>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[0] === '</navPoint>') { if (stack.length > 1) stack.pop(); continue; }
    if (m[0].startsWith('<navPoint')) {
      const node = { text: '', src: '', children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }
    const node = stack[stack.length - 1];
    if (m[1] !== undefined) node.text = m[1];
    else if (m[2] !== undefined) node.src = m[2];
  }
  return root;
}

function parseTocPage(tocHtml) {
  const root = { text: '(toc page)', src: '', children: [] };
  const stack = [root];
  // Coupled to the render source on purpose: renderTocHtml (scripts/generater.js:647)
  // emits every entry as a bare attribute-free `<li><a href="src">text</a>` and
  // nests children INSIDE the parent <li>. If that renderer ever changes shape,
  // this parser must change with it (the <div class="toc"> self-check below is
  // the tripwire that a different page reached here).
  const re = /<li>|<\/li>|<a href="([^"]*)">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(tocHtml))) {
    if (m[0] === '<li>') {
      const node = { text: '', src: '', children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      continue;
    }
    if (m[0] === '</li>') { if (stack.length > 1) stack.pop(); continue; }
    const node = stack[stack.length - 1];
    node.src = m[1];
    node.text = m[2];
  }
  return root;
}

function walkTree(node, fn, depth = 0) {
  for (const child of node.children) { fn(child, depth); walkTree(child, fn, depth + 1); }
}

const countNodes = (root) => { let n = 0; walkTree(root, () => { n += 1; }); return n; };

// 1 = every node is a direct child of the root (flat), 2 = one level of
// parent/child nesting, and so on.
const treeDepth = (root) => {
  let d = 0;
  walkTree(root, (node, depth) => { d = Math.max(d, depth + 1); });
  return d;
};

const parentRows = (root) => {
  const rows = [];
  walkTree(root, (node, depth) => { if (node.children.length) rows.push({ text: node.text, depth, kids: node.children.length }); });
  return rows;
};

// The template's always-present extra navPoint (generater.js 'references'),
// which has no counterpart on the TOC page and so must not be compared.
const dropTemplateReferences = (root) => {
  root.children = root.children.filter((c) => !(c.src.startsWith('references.xhtml') && !c.children.length));
  return root;
};

const shapeSignature = (root) => {
  const rows = [];
  walkTree(root, (node, depth) => rows.push(`${'  '.repeat(depth)}${node.text} -> ${node.src}`));
  return rows.join('\n');
};

mkdirSync(OUT, { recursive: true });
let server;
let brave;
let stderr = '';
let exitCode = 0;
try {
  // ── Run plan, decided BEFORE anything is spawned ──────────────────────────
  if (ONE_PER_BOOK && !explicitFixtures) fixtures.push(VOLUME_FIXTURE);
  const runs = ONE_PER_BOOK
    ? fixtures.map((f) => [f])
    : (explicitFixtures
      ? [fixtures]
      : [fixtures, ...PAGINATED_FAMILIES.map((f) => [f.root]), [VOLUME_FIXTURE]]);

  // ─── Zero-coverage gate (all run shapes: default, --one-per-book, explicit) ─
  // The stale-bundle discriminator only exists if a volume book is in the run.
  // A green run without it proves nothing about the carry-over, so refuse to
  // even start the browser for one; the throw follows the probe's normal
  // failure path (catch -> exitCode 1) below.
  // STARTUP_SKIPPED records that the bypass really took effect (TOC_E2E_SKIP_VOLUME=1
  // with no volume book in any run) — the flag is what the closing banner prints, so
  // the bypass cannot be lost in the middle of a long log.
  let STARTUP_SKIPPED = false;
  if (!runs.some(isVolumeBook)) {
    if (SKIP_VOLUME) {
      STARTUP_SKIPPED = true;
      console.log('[e2e] volume discriminator: SKIPPED for this whole run'
        + ' (TOC_E2E_SKIP_VOLUME=1) — the stale-bundle discriminator is NOT covered by it');
    } else {
      throw new Error(`volume discriminator book (${VOLUME_FIXTURE}) not in this run; `
        + 'pass it explicitly or set TOC_E2E_SKIP_VOLUME=1 有意跳过 (skip the discriminator on purpose)');
    }
  }

  server = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--directory', FIXDIR],
    { stdio: 'ignore' });
  brave = spawn(BRAVE, [
    ...(HEADLESS ? ['--headless=new'] : []),
    '--disable-gpu', '--no-sandbox', '--fingerprinting-protection=0',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${APP}`, `--load-extension=${APP}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  brave.stderr.on('data', (d) => { stderr += d.toString(); });

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
      const summary = document.querySelector('#pagination-summary');
      return opts ? {
        filename: opts.filename,
        url: opts.url,
        summaryElement: !!summary,
        summaryText: summary ? summary.textContent : null,
      } : null;
    })()`);
    if (!dataUrl) throw new Error('popup never called chrome.downloads.download');
    console.log('[e2e] download requested as:', dataUrl.filename);
    if (!dataUrl.summaryElement) throw new Error('popup has no #pagination-summary element');
    if (!dataUrl.summaryText || !dataUrl.summaryText.trim()) {
      throw new Error('#pagination-summary is present but EMPTY after the export completed');
    }
    console.log('[e2e] #pagination-summary =', JSON.stringify(dataUrl.summaryText));

    const buf = Buffer.from(dataUrl.url.split(',')[1], 'base64');
    const label = group.map((f) => basename(f, '.html')).join('+');
    writeFileSync(join(OUT, `${label}.epub`), buf);
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).sort();
    console.log('[e2e] parts:', names.filter((n) => !n.endsWith('/')).join(' '));

    const ncx = await zip.file('OEBPS/toc.ncx').async('string');
    const ncxPoints = (ncx.match(/<navPoint/g) || []).length;
    // The full per-navPoint dump is the stdout hog (volume book: 215 points ≈
    // 860 lines), so it is capped; the tables below carry the assertions.
    if (ncxPoints <= 60 || process.env.TOC_E2E_VERBOSE) {
      console.log(ncx.slice(ncx.indexOf('<navMap>'), ncx.indexOf('</navMap>') + 9).replace(/\n {8}/g, '\n  '));
    } else {
      console.log(`[e2e] navMap: ${ncxPoints} navPoints > 60 — full dump suppressed (set TOC_E2E_VERBOSE=1 to print it)`);
    }

    const parts = {};
    for (const n of names.filter((x) => x.endsWith('.xhtml'))) parts[n] = await zip.file(n).async('string');
    const deadParts = Object.entries(parts).filter(([, xml]) => /parsererror/.test(xml)).map(([n]) => n);
    const links = [...ncx.matchAll(/<content src="([^"#]+)#([^"]+)"\/>/g)];
    const dead = links.filter((m) => !(parts[`OEBPS/${m[1]}`] || '').includes(`id="${m[2]}"`))
      .map((m) => `${m[1]}#${m[2]}`);
    const depth = (ncx.match(/dtb:depth" content="(\d+)"/) || [])[1];
    console.log('[e2e] dtb:depth =', depth,
      '| navPoints =', ncxPoints,
      '| fragment links =', links.length, '| dead =', dead.length ? dead.join(',') : 'none',
      '| parsererror =', deadParts.length ? deadParts.join(',') : 'none');

    // ── toc.ncx <-> visible TOC page must be the SAME tree (plan todo 9) ────
    // chapter1.xhtml is that page: generateEpub unshifts the TOC page before
    // the chapters get numbered, so the TOC is always chapter1.
    const tocHtml = parts['OEBPS/chapter1.xhtml'];
    if (!tocHtml) throw new Error(`FAILED [${label}] no OEBPS/chapter1.xhtml — the auto-generated TOC page is missing`);
    // Self-proof that chapter1.xhtml really IS the generated TOC page:
    // renderTocHtml wraps its output in <div class="toc"> (scripts/generater.js:
    // 647-655) unconditionally, so anything without it is a different page and
    // every <li>/<a> count taken below (tocEntries) may be empty or meaningless.
    if (!tocHtml.includes('<div class="toc">')) {
      throw new Error(`FAILED [${label}] OEBPS/chapter1.xhtml contains no <div class="toc"> — `
        + `it is not the auto-generated TOC page, so the tocEntries measured below may be empty`);
    }

    const tocItems = (tocHtml.match(/<li>/g) || []).length;

    // (1) The nav template closes with one navPoint the TOC page never shows:
    // its own 'References' row (generater.js template), so ncx is expected to
    // hold exactly one more node than the page. Anything else = the two
    // renderers saw different trees. Not a stale-bundle discriminator: it holds
    // for the old bundle too.
    if (ncxPoints - 1 !== tocItems) {
      throw new Error(`FAILED [${label}] ncx/page node counts disagree: `
        + `(ncx.match(/<navPoint/g)||[]).length - 1 = ${ncxPoints - 1} !== `
        + `(tocHtml.match(/<li>/g)||[]).length = ${tocItems} — expected exactly one extra navPoint `
        + `(the template's References row)`);
    }

    // Rebuild both trees and compare them node for node, ignoring only the
    // template References navPoint that has no counterpart on the page.
    const ncxRoot = dropTemplateReferences(parseNcxNavMap(ncx));
    const tocRoot = parseTocPage(tocHtml);
    const ncxParents = parentRows(ncxRoot);
    const tocParents = parentRows(tocRoot);
    const ncxSig = shapeSignature(ncxRoot);
    const tocSig = shapeSignature(tocRoot);

    // (2) THE stale-bundle discriminator. renderTocHtml emits a parent's
    // children INSIDE that parent's <li>, so treeDepth >= 2 iff at least one
    // <li> substring contains a nested <li>. Only required for the volume
    // book: there, the sole source of a second level is splitVolumeEntry's
    // volume parent (scripts/toc.js:72), which an unbuilt bundle never had.
    const requiresNesting = isVolumeBook(group);
    // (2b) Shape lock — only while the volume book is ALONE in the group.
    // Grouping it with another fixture is a documented usage (the zero-coverage
    // gate even advises "pass it explicitly"), and then the outline legitimately
    // carries that fixture's rows too: parents and child counts are NOT
    // {76,40,89,6} by construction, so applying the lock there is a false red.
    // The nesting-existence check above still runs for mixed groups, as do the
    // count and node-for-node tree comparisons below.
    const shapeLock = requiresNesting && group.length === 1;
    const tocNested = treeDepth(tocRoot) >= 2;
    if (requiresNesting && !tocNested) {
      throw new Error(`FAILED [${label}] the TOC page is FLAT: no parent <li> contains a child <li> `
        + `(ncx treeDepth=${treeDepth(ncxRoot)}, dtb:depth=${depth}, parents=${tocParents.length}). `
        + `Volume carry-over never ran — app/build/popup.js is STALE; rebuild it with 'npm run build'.`);
    }

    // Shape lock for exactly that book: the stale bundle is FLAT (0
    // parents), but "not flat" alone would also pass a half-broken carry-over.
    // Measured on the rebuilt bundle (t9 evidence) and equal to the T7 node
    // suite's declared label spans 1-76/77-116/117-205/206-211 (sum 211).
    // Read from tocParents — the same parse that feeds the two-tree comparison,
    // no extra parser.
    if (shapeLock) {
      const WANT_KIDS = [76, 40, 89, 6];
      const gotKids = tocParents.map((p) => p.kids);
      const multiset = (xs) => [...xs].sort((a, b) => a - b).join(',');
      if (tocParents.length !== 4 || multiset(gotKids) !== multiset(WANT_KIDS)) {
        throw new Error(`FAILED [${label}] volume book shape lock: expected 4 parents with `
          + `child-count multiset {76,40,89,6}, got parents=${tocParents.length} kids=[${gotKids.join(',')}] `
          + `— the carry-over grouped the 211 labels wrongly.`);
      }
    }

    // Shape equality is the real "ncx == contents page" claim.
    if (ncxSig !== tocSig) {
      const a = ncxSig.split('\n');
      const b = tocSig.split('\n');
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      throw new Error(`FAILED [${label}] toc.ncx and the TOC page describe different trees: `
        + `first difference at row ${i}\n  ncx: ${JSON.stringify(a.slice(i, i + 3))}\n  page: ${JSON.stringify(b.slice(i, i + 3))}`);
    }
    // Diagnostics only: ncxSig === tocSig above is the primary verdict and
    // already implies equal parent counts, so this throw is unreachable when
    // sig matched. Kept (assertions are not relaxed) as a second line of
    // defence plus a clearer message if sig and this ever disagree.
    if (ncxParents.length !== tocParents.length) {
      throw new Error(`FAILED [${label}] parent node count differs: ncx=${ncxParents.length} page=${tocParents.length}`);
    }

    // ── comparison table ──
    const row = (k, v) => `    ${k.padEnd(30)}${v}`;
    const lines = [
      `[e2e] outline comparison [${label}] (nesting required: ${requiresNesting ? 'YES (volume carry-over book)' : 'no'})`,
      row('', 'toc.ncx            chapter1.xhtml (TOC page)'),
      row('raw node count', `${String(ncxPoints).padEnd(18)}${tocItems}`),
      row('raw count - ncx-1 === page', `${(ncxPoints - 1 === tocItems ? 'OK' : 'MISMATCH').padEnd(18)}(want ncx-1 === page)`),
      row('parsed nodes (refs dropped)', `${String(countNodes(ncxRoot)).padEnd(18)}${countNodes(tocRoot)}`),
      row('tree depth (1 = flat)', `${String(treeDepth(ncxRoot)).padEnd(18)}${treeDepth(tocRoot)}`),
      row('parent nodes', `${String(ncxParents.length).padEnd(18)}${tocParents.length}`),
      row('dtb:depth / nesting', `${String(depth).padEnd(18)}nested <li> present = ${tocNested}`),
      row('nesting shape lock', shapeLock ? 'APPLIED (4 parents, child counts {76,40,89,6})'
        : requiresNesting ? 'skipped (book grouped with others)' : 'n/a (not the volume book)'),
      row('trees identical node-for-node', `${(ncxSig === tocSig ? 'YES' : 'NO').padEnd(18)}${ncxSig.split('\n').length} rows compared`),
    ];
    if (tocParents.length) {
      // Diagnostic print: the sig-equality verdict above already forces every
      // row to match text-by-text and kids-by-kids, so DIFF is unreachable
      // after it; the rows stay as visible per-parent evidence.
      lines.push('    parents (ncx text/kids vs page text/kids):');
      tocParents.forEach((p, i) => {
        const n = ncxParents[i];
        const same = n && n.text === p.text && n.kids === p.kids;
        lines.push(`      ${String(i).padStart(3)}  ${same ? 'OK  ' : 'DIFF'}  ncx ${JSON.stringify(n ? n.text : null)}=${n ? n.kids : '-'}  page ${JSON.stringify(p.text)}=${p.kids}`);
      });
    } else {
      lines.push('    parents: none on either side (flat outline)');
    }
    console.log(lines.join('\n'));

    const family = group.length === 1 ? PAGINATED_FAMILIES.find((f) => f.root === group[0]) : null;
    if (family) {
      // The auto-TOC page also mentions every sentinel once, so the merged
      // article is the chapter carrying the merge markers; the sentinel count
      // only breaks ties (e.g. when the merge failed and no markers exist).
      const scored = Object.entries(parts).map(([name, xml]) => ({
        name,
        xml,
        markers: xml.split(MERGE_MARKER).length - 1,
        hits: family.sentinels.reduce((n, s) => n + (xml.split(s).length - 1), 0),
      })).sort((a, b) => (b.markers - a.markers) || (b.hits - a.hits));
      const article = scored[0];
      if (!article || article.hits === 0) {
        throw new Error(`FAILED merged pagination for ${family.root}: no chapter contains ${family.sentinels[0]}`);
      }
      const missing = family.sentinels.filter((s) => !article.xml.includes(s));
      console.log(`[e2e] merged-pagination ${family.root}: article=${article.name} ` +
        `markers=${article.markers} (expected 2) missing=${missing.length ? missing.join(',') : 'none'}`);
      if (missing.length) {
        throw new Error(`FAILED merged pagination for ${family.root}: ${missing.join(', ')} missing from ${article.name}`);
      }
      if (article.markers !== 2) {
        throw new Error(`FAILED merged pagination for ${family.root}: expected exactly 2 '${MERGE_MARKER}' in ${article.name}, got ${article.markers}`);
      }
    }

    await cdp.closePage(popup.targetId).catch(() => {});
    for (const p of pages) await cdp.closePage(p.targetId).catch(() => {});
  }

  // Tail banner for the bypass: the STARTUP_SKIPPED note scrolls far away in a
  // 300-line run, and a green exit code is otherwise read as "bundle verified".
  // Exit code stays 0 on purpose (the review asked for visibility, not a verdict
  // change) — what this run does NOT cover is stated where it cannot be missed.
  if (STARTUP_SKIPPED) {
    console.log('\n' + '*'.repeat(78));
    console.log('[e2e] volume discriminator: SKIPPED — this run does NOT prove the bundle is fresh');
    console.log('*'.repeat(78));
  }
} catch (err) {
  exitCode = 1;
  console.error('[e2e] FAILED:', err.message);
  if (stderr) console.error('[brave stderr tail]', stderr.slice(-600));
} finally {
  // The startup gate can throw before anything was spawned: guard both kills.
  if (brave) brave.kill();
  if (server) server.kill();
  setTimeout(() => {
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* brave may still hold it */ }
    process.exit(exitCode);
  }, 1000);
}
