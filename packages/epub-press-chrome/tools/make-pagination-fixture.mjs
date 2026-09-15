// Builds a 3-page paginated novel fixture for the auto-pagination regression repro.
//   node tools/make-pagination-fixture.mjs
// Output: tests/fixtures/toc/pag-page-{1,2,3}.html
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(PKG, 'tests', 'fixtures', 'toc');
mkdirSync(DEST, { recursive: true });

const LOREM = '他站在天台的边缘往下看，整座城市的灯火像打翻的棋局，横竖都没有尽头。风从海面过来，带着咸味和一点点铁锈气，把他手里那页纸吹得哗哗作响。上面只有一行字，是他父亲留下的全部东西，也是他花了七年才敢重新读一遍的东西。楼下有人拉了手风琴，曲子跑得七零八落，倒比任何体面的演奏都更像这个夜晚。他忽然明白，所谓故乡，并不是一个可以回去的地方，而是一串你必须替别人走完的路。他把纸折好放进口袋，转身下楼，楼梯间的灯坏了三盏，他在黑暗里数着自己的脚步声，一级一级，像是在替谁偿还什么。';

function chapterBlock(sentinel, ordinal, title, paras) {
  const body = paras.map((p) => `<p>${p}</p>`).join('\n      ');
  return `
      <section class="chapter">
        <p>第${ordinal}节 ${title}</p>
        ${body}
        <p>〔${sentinel}〕本段结束，往下翻页继续。</p>
      </section>`;
}

function page(n, sentinel, title, nextHref, prevHref) {
  const paras = [LOREM, LOREM.replace('天台的边缘', '走廊的尽头'), LOREM.replace('手风琴', '口琴')];
  const nav = [];
  if (prevHref) nav.push(`<a href="${prevHref}" class="prev">上一页</a>`);
  nav.push('<a href="/pag-book.html">返回目录</a>');
  if (nextHref) nav.push(`<a href="${nextHref}" class="next">下一页</a>`);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${title}（${n}/3）— 分页测试书</title>
</head>
<body>
  <div id="readabilityPage">
    <h1>${title}</h1>
    ${chapterBlock(sentinel, n === 1 ? '一' : n === 2 ? '二' : '三', title, paras)}
    <div class="pagenav">${nav.join(' ')}</div>
  </div>
</body>
</html>
`;
}

const pages = [
  ['pag-page-1.html', 'PAGE1SENTINEL', '春潮', 'pag-page-2.html', null],
  ['pag-page-2.html', 'PAGE2SENTINEL', '春潮', 'pag-page-3.html', 'pag-page-1.html'],
  ['pag-page-3.html', 'PAGE3SENTINEL', '春潮', null, 'pag-page-2.html'],
];
pages.forEach(([file, sentinel, title, next, prev]) => {
  const n = file.charAt(file.length - 6);
  writeFileSync(join(DEST, file), page(Number(n), sentinel, title, next, prev));
  console.log('wrote', file, sentinel);
});
