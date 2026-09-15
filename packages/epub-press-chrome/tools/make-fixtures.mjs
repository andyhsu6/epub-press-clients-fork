// Derives trimmed repo fixtures from the REAL pages captured by tools/toc-probe.mjs.
//   node tools/make-fixtures.mjs        (needs .omo/toc-probe/*.html from the probe)
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(PKG, '..', '..', '.omo', 'toc-probe') + '/';
const DEST = join(PKG, 'tests', 'fixtures', 'toc');
mkdirSync(DEST, { recursive: true });

const load = (f) => parseHTML(readFileSync(SRC + f, 'utf8')).document;
const titleOf = (doc) => (doc.querySelector('title')?.textContent || '').trim();
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

const page = (title, lang, body) => `<!DOCTYPE html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}</body></html>
`;

// --- ibbs.pro: forum thread, 13 chapters crammed into <p> blocks of <br> lines ---
{
  const doc = load('ibbs.pro_thread_68805aecf30dda264d164fe9.html');
  const keep = [];
  let chapters = 0;
  doc.querySelectorAll('p').forEach((p) => {
    const brs = p.querySelectorAll('br').length;
    if (brs >= 5) {
      // keep the title line plus a few real body lines, drop the rest
      const parts = (p.innerHTML || '').split(/<br\s*\/?>\s*/i);
      const head = parts.slice(0, 6).join('<br>');
      const clone = doc.createElement('p');
      clone.innerHTML = head;
      keep.push(clone.outerHTML);
      chapters++;
    } else if (/发表于|十步杀一人/.test(norm(p.textContent))) {
      keep.push(p.outerHTML);
    }
  });
  const out = page(titleOf(doc), 'zh-CN', `<div class="col-12">${keep.join('\n')}</div>`);
  writeFileSync(`${DEST}/ibbs-forum-13chapters.html`, out);
  console.log('ibbs: chapters kept =', chapters, '| bytes =', out.length);
}

// --- uaa.com: proper reader, real <h1 class="reader-chap"> duplicating <title> ---
{
  const doc = load('uaa.com_novel_chapter.html');
  const chap = doc.querySelector('h1.reader-chap');
  const content = doc.querySelector('.reader-content') || chap?.parentElement;
  const paras = [...content.querySelectorAll('p')].slice(0, 14).map((p) => p.outerHTML);
  const body = `<section class="reader-chapseg"><div class="reader-content">${chap.outerHTML}${paras.join('\n')}</div></section>`;
  const out = page(titleOf(doc), 'zh-CN', body);
  writeFileSync(`${DEST}/uaa-reader-h1.html`, out);
  console.log('uaa: h1 =', JSON.stringify(norm(chap.textContent)), '| paras =', paras.length, '| bytes =', out.length);
}
