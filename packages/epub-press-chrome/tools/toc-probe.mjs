// Probe real pages: raw DOM chapter-title candidates + what the EPUB pipeline
// actually keeps after extraction. Launches its own headless Brave (temp profile).
//
//   node tools/toc-probe.mjs <url> [<url> ...]
//
// Artifacts land in .omo/toc-probe/ (raw html + report). Read-only w.r.t. the pages.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFromHtml } from '@extractus/article-extractor';
import { parseHTML } from 'linkedom';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(PKG, '..', '..', '.omo', 'toc-probe');
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const PORT = 9223;
const PROFILE = '/tmp/brave-toc-probe-profile';

// Deliberately broad: the point is to learn where titles actually live,
// not to confirm a guess.
const CHAPTERISH = '第\\s*[0-9一二三四五六七八九十百千零〇两壹贰叁]+\\s*[章节回篇卷部节辑]|Chapter\\s*\\d+|Part\\s*\\d+|Section\\s*\\d+|序章|楔子|引子|尾声|后记|番外|目录';

const CHALLENGE = /请稍候|安全验证|验证成功|Just a moment|Checking your browser|Verify you are human|attention required/i;

// Wait until the document is complete AND its visible text length has settled.
async function settle(cdp, budgetMs = Number(process.env.TOC_PROBE_WAIT) || 25000) {
  const deadline = Date.now() + budgetMs;
  let prev = -1, stable = 0, last = null;
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({rs:document.readyState,len:document.body&&document.body.innerText?document.body.innerText.length:0,title:document.title})',
      returnByValue: true,
    });
    last = JSON.parse(r.result.value || '{}');
    if (last.rs === 'complete' && last.len > 400 && last.len === prev) { if (++stable >= 2) break; } else stable = 0;
    prev = last.len;
    await new Promise((res) => setTimeout(res, 900));
  }
  return { ...last, challenged: CHALLENGE.test(last?.title || '') };
}

// Runs inside the page. Reports every innermost element whose own text looks
// like a heading, with enough shape info to design a general detector.
async function scanRaw(cdp, url) {
  await cdp.send('Page.navigate', { url });
  const state = await settle(cdp);
  if (state.challenged) console.log('  !! bot challenge or interstitial still present:', JSON.stringify(state.title));
  const expression = `(() => {
    const RE = new RegExp(${JSON.stringify(CHAPTERISH)});
    const sel = 'h1,h2,h3,h4,h5,h6,p,div,span,a,strong,b,em,li,dt,dd,font,label,td,hgroup,header';
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const firstLine = (el) => {
      let out = '';
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeName === 'BR') break;
        if (n.nodeType === 3 || n.nodeType === 1) out += n.textContent;
      }
      return norm(out) || norm((el.textContent || '').split('\\n')[0]);
    };
    const all = Array.from(document.querySelectorAll(sel));
    const hits = [];
    all.forEach((el) => {
      const full = norm(el.textContent);
      if (!full) return;
      const br = el.querySelectorAll('br').length;
      if (full.length <= 60 && RE.test(full)) { hits.push({ el, mode: 'whole' }); return; }
      if (br > 0) {
        const line = firstLine(el);
        if (line && line.length <= 45 && RE.test(line)) hits.push({ el, mode: 'firstLine' });
      }
    });
    const set = new Set(hits.map((h) => h.el));
    const innermost = hits.filter((h) => !Array.from(h.el.querySelectorAll(sel)).some((c) => set.has(c)));
    const path = (el) => {
      const out = [];
      let n = el;
      for (let i = 0; i < 3 && n && n.tagName; i++) {
        out.push(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
        n = n.parentElement;
      }
      return out.join(' < ');
    };
    return JSON.stringify({
      title: document.title,
      url: location.href,
      total: innermost.length,
      brInBody: document.querySelectorAll('br').length,
      headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => h.tagName + '.' + (h.className || '') + '|' + (h.textContent || '').trim().slice(0, 30)),
      samples: innermost.slice(0, 45).map(({ el, mode }) => ({
        tag: el.tagName.toLowerCase(),
        mode,
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
        br: el.querySelectorAll('br').length,
        kids: el.childElementCount,
        textLen: (el.textContent || '').trim().length,
        path: path(el.parentElement),
        text: (mode === 'firstLine' ? firstLine(el) : norm(el.textContent)).slice(0, 40),
      })),
    });
  })()`;
  const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
  return JSON.parse(res.result.value);
}

// What the shipped pipeline sees, and what today's two strategies make of it.
async function scanExtracted(html, url) {
  const article = await extractFromHtml(html, url);
  if (!article) return { null: true };
  const { document } = parseHTML(`<body>${article.content || ''}</body>`);
  // Verbatim copy of the shipped Strategy B rule (generater.js:577-586) so the
  // probe reports what production would do, not what this tool could do.
  const SHIPPED_B = /^第[一二三四五六七八九十零〇百千万\d]+[章节回篇部集]/;
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({
    tag: h.tagName.toLowerCase(),
    level: parseInt(h.tagName[1], 10),
    text: (h.textContent || '').trim().slice(0, 40),
  }));
  const paras = Array.from(document.querySelectorAll('p'));
  const strategyA = Array.from(document.querySelectorAll('h1, h2, h3, h4')).length;
  const strategyB = [];
  paras.forEach((p) => {
    const fullText = (p.textContent || '').trim();
    if (!fullText) return;
    if (p.querySelector('h1, h2, h3, h4')) return;
    if (!SHIPPED_B.test(fullText)) return;
    const html = p.innerHTML || '';
    const brIdx = html.indexOf('<br>');
    let titleText = fullText;
    if (brIdx > 0) {
      const { document: d } = parseHTML(`<body>${html.substring(0, brIdx)}</body>`);
      titleText = (d.body.textContent || '').trim();
    }
    if (titleText) strategyB.push(titleText.slice(0, 40));
    else strategyB.push({ empty: true, innerHTMLHead: html.slice(0, 50), fullHead: fullText.slice(0, 30) });
  });
  // Where does the chapter line actually live post-extraction?
  const loose = [];
  paras.forEach((p, i) => {
    const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
    const first = t.split('　').filter(Boolean)[0] || t;
    if (new RegExp(CHAPTERISH).test(first) && first.length <= 40) loose.push({ i, line: first });
  });
  return {
    title: article.title,
    contentLen: (article.content || '').length,
    br: document.querySelectorAll('br').length,
    pCount: paras.length,
    headings,
    strategyAHits: strategyA,
    strategyBHits: strategyB,
    looseTitleLines: loose.slice(0, 10),
  };
}

async function main() {
  const urls = process.argv.slice(2);
  if (!urls.length) { console.error('usage: node tools/toc-probe.mjs <url> ...'); process.exit(2); }
  mkdirSync(OUT, { recursive: true });

  const headed = process.env.TOC_PROBE_HEADED === '1';
  const brave = spawn(BRAVE, [
    ...(headed ? [] : ['--headless=new']),
    '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (headed) console.log('[probe] TOC_PROBE_HEADED=1 — a visible Brave window is opening');
  let stderr = '';
  brave.stderr.on('data', (d) => { stderr += d.toString(); });

  const wsUrl = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('Brave never came up:\n' + stderr.slice(-800))), 25000);
    const poll = () => fetch(`http://127.0.0.1:${PORT}/json/version`)
      .then((r) => r.json()).then((d) => { clearTimeout(to); resolve(d.webSocketDebuggerUrl); })
      .catch(() => setTimeout(poll, 400));
    poll();
    brave.on('exit', (c) => reject(new Error(`Brave exited ${c}`)));
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const targets = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Target.attachedToTarget') {
      targets.set(m.params.targetInfo.targetId, m.params.sessionId);
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const rawSend = (method, params, sessionId) => new Promise((r) => {
    const n = ++id;
    pending.set(n, r);
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  await rawSend('Target.setDiscoverTargets', { discover: true });

  const report = [];
  for (const url of urls) {
    console.log('\n=== ' + url);
    const att = await rawSend('Target.createTarget', { url: 'about:blank' });
    const targetId = att.result.targetId;
    await rawSend('Target.attachToTarget', { targetId, flatten: true });
    const sid = targets.get(targetId);
    const cdp = { send: (m, p) => rawSend(m, p, sid).then((r) => { if (r.error) throw new Error(m + ': ' + r.error.message); return r.result; }) };
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    try {
      const raw = await scanRaw(cdp, url);
      const dom = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
      const html = dom.result.value || '';
      const u = new URL(url);
      const slug = ((u.hostname + u.pathname).replace(/^www\./, '').replace(/[^a-z0-9._-]+/gi, '_').replace(/_+$/, '') || 'page').slice(-70);
      writeFileSync(join(OUT, `${slug}.html`), html);
      const ext = await scanExtracted(html, url);
      report.push({ url, raw, ext });
      console.log('raw title   :', raw.title);
      console.log('chapter-ish :', raw.total, 'innermost nodes');
      console.log('raw headings:', raw.headings.slice(0, 12).join(' , ') || '(none)');
      const dist = {};
      raw.samples.forEach((s) => { dist[`${s.tag}.${s.cls.split(' ')[0]}`] = (dist[`${s.tag}.${s.cls.split(' ')[0]}`] || 0) + 1; });
      console.log('tag/class   :', Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join('  '));
      console.log('samples     :');
      raw.samples.slice(0, 12).forEach((s) => console.log(`   ${s.tag}[${s.mode}] #${s.kids}kids br=${s.br} len=${s.textLen} [${s.cls}] "${s.text}"   «${s.path}»`));
      console.log('--- after extraction ---');
      if (ext.null) {
        console.log('extractor returned NULL — no article detected (challenge page, JS shell, or too little text)');
      } else {
      console.log('ext title   :', ext.title, '| contentLen', ext.contentLen, '| <br>', ext.br, '| <p>', ext.pCount);
      console.log('kept headings:', ext.headings.length ? ext.headings.map((h) => `${h.tag}(L${h.level}) "${h.text}"`).join(' , ') : '(NONE — destroyed upstream)');
      console.log('strategyA   :', ext.strategyAHits, '| strategyB:', JSON.stringify(ext.strategyBHits));
      if (ext.looseTitleLines.length) console.log('title-lines now inside <p>:', JSON.stringify(ext.looseTitleLines.slice(0, 6)));
      }
      console.log('saved       :', join(OUT, `${slug}.html`), `(${(html.length / 1024).toFixed(0)}KB)`);
    } catch (err) {
      console.log('FAILED:', err.message);
      report.push({ url, error: err.message });
    } finally {
      await rawSend('Target.closeTarget', { targetId }).catch(() => {});
    }
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n[probe] report ->', join(OUT, 'report.json'));
  ws.close();
  brave.kill();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
