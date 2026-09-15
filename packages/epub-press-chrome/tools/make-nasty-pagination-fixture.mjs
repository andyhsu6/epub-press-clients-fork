// Builds a paginated fixture from REAL captured page markup, then adds the markup
// shapes that a clean synthetic fixture never exercises (br/font soup, raw entities,
// HTML comments, <template>, unclosed tags, CDATA-ish text, very long tail).
// If the TOC re-serialization truncates merged content, this is where it shows.
//   node tools/make-nasty-pagination-fixture.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = join(PKG, '..', '..', '.omo', 'toc-probe', 'ibbs.pro_thread_68805aecf30dda264d164fe9.html');
const DEST = join(PKG, 'tests', 'fixtures', 'toc');
mkdirSync(DEST, { recursive: true });

const doc = parseHTML(readFileSync(REAL, 'utf8')).document;
const paras = [];
doc.querySelectorAll('p').forEach((p) => {
  const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
  if (t.length > 40) paras.push(p.outerHTML);
});
if (paras.length < 12) throw new Error('not enough real paragraphs: ' + paras.length);

const third = Math.ceil(paras.length / 3);
const chunks = [paras.slice(0, third), paras.slice(third, third * 2), paras.slice(third * 2)];

// Deliberately hostile markup, appended to each page after the real paragraphs.
const TORTURE = [
  '<p>TAKE-NOTE-A 实体测试 &amp; &nbsp; &#20013; &lt;tag&gt; 结束</p>',
  '<!-- 注释跨越分页 TAKE-NOTE-B --><p>注释后的段落 TAKE-NOTE-C</p>',
  '<div><font size="2" color="#0000ff"><span>嵌套 font/span TAKE-NOTE-D</span></font></div>',
  '<template><p>模板里的内容 TAKE-NOTE-E</p></template>',
  '<p>未闭合标签 TAKE-NOTE-F <b>加粗没关<div>块级嵌进 p</div>',
  '<iframe src="about:blank"></iframe><noscript>noscript TAKE-NOTE-G</noscript>',
  '<p>特殊字符 &lt;/body&gt; 与 &lt;/p&gt; 转义 TAKE-NOTE-H</p>',
].join('\n');

function page(n, sentinel, next) {
  const prev = n > 1 ? `np-page-${n - 1}.html` : null;
  const nav = [`<a href="np-book.html">返回目录</a>`];
  if (prev) nav.push(`<a href="${prev}">上一页</a>`);
  if (next) nav.push(`<a href="${next}" class="next">下一页</a>`);
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>母妻手记 第${n}页 — 论坛</title></head>
<body><div class="col-12">
  <div class="post-content">
    <p>第${['一', '二', '三'][n - 1]}章 段落组 ${sentinel}</p>
    ${chunks[n - 1].join('\n')}
    ${TORTURE}
    <p>〔${sentinel}〕本页结束</p>
  </div>
  <div class="pagenav">${nav.join(' ')}</div>
</div></body></html>
`;
}

['NPSENT1', 'NPSENT2', 'NPSENT3'].forEach((sentinel, i) => {
  const n = i + 1;
  const next = n < 3 ? `np-page-${n + 1}.html` : null;
  const file = join(DEST, `np-page-${n}.html`);
  writeFileSync(file, page(n, sentinel, next));
  console.log('wrote np-page-' + n + '.html', '| real paras:', chunks[i].length, '| bytes:', (chunks[i].length, page(n, sentinel, next).length));
});
