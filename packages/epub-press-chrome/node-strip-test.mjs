// Node-native verification of stripExternalLinkBlocks via the real generateTxt chain.
// Mirrors the mocha assertions in tests/generater-test.js but runs under `node --test`.
// Uses linkedom as a browser-DOM shim (article-extractor's own DOM implementation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, NodeFilter } from 'linkedom';

// 变体副本, not the 规范副本 form: the same named-class shape, but a different globalThis.fetch
// message ('fetch not expected in tests'). The 规范副本 is tests/toc.node-test.mjs (also
// toc-volume-carryover / toc-volume-e2e) — align this block with it first, then diff.
class BrowserLikeDOMParser extends DOMParser {
  parseFromString(html, type) {
    if (type === 'text/html' && typeof html === 'string' && !/^\s*(<!DOCTYPE|<html)/i.test(html)) {
      return super.parseFromString(`<html><body>${html}</body></html>`, type);
    }
    return super.parseFromString(html, type);
  }
}
class XMLSerializer {
  serializeToString(node) { return node.toString(); }
}
globalThis.DOMParser = BrowserLikeDOMParser;
globalThis.NodeFilter = NodeFilter;
globalThis.XMLSerializer = XMLSerializer;
globalThis.fetch = async () => { throw new Error('fetch not expected in tests'); };

const { generateTxt } = await import('./scripts/generater.js');

const FILLER = '这是一段足够长的正文填充文字，用来确保文章内容超过提取器的最小长度阈值，从而让整个提取链路正常工作。'.repeat(4);

const makeBook = (bodyHtml) => ({
  title: 'Clean Book',
  includeImages: false,
  sections: [{
    url: 'https://example.com/article/1',
    html: `<!DOCTYPE html>
<html lang="zh">
<head><title>Clean Article</title></head>
<body>
    <article>
        <h1>Clean Article</h1>
        ${bodyHtml}
    </article>
</body>
</html>`,
  }],
});

test('removes external-domain link blocks (ad/recommendation)', async () => {
  const body = `<p>${FILLER}</p>
            <a href="https://ads.example.net/landing"><div class="h5">广告书名</div><div>广告作者</div><div>广告简介</div></a>
            <p>之后还有正文。</p>`;
  const text = await (await generateTxt(makeBook(body))).text();
  assert.ok(!text.includes('广告书名'), 'ad book title must be removed');
  assert.ok(!text.includes('广告作者'), 'ad author must be removed');
  assert.ok(!text.includes('广告简介'), 'ad blurb must be removed');
  assert.ok(text.includes('之后还有正文'), 'surrounding text must remain');
});

test('removes bare URL strings from text', async () => {
  const body = `<p>${FILLER}</p>
            <p>正文 https://www.ibbs.pro/thread/abc?pagenumber=2 继续阅读。</p>`;
  const text = await (await generateTxt(makeBook(body))).text();
  assert.ok(!text.includes('https://www.ibbs.pro/thread/abc'), 'bare URL must be removed');
  assert.ok(text.includes('继续阅读'), 'text after URL must remain');
});

test('removes bare URLs followed by Chinese punctuation', async () => {
  const body = `<p>${FILLER}</p>
            <p>正文 https://www.ibbs.pro/thread/abc。继续阅读。</p>`;
  const text = await (await generateTxt(makeBook(body))).text();
  assert.ok(!text.includes('https://www.ibbs.pro/thread/abc'), 'URL before 。 removed');
  assert.ok(text.includes('继续阅读'), 'text after 。 remains');
});

test('keeps same-domain links (in-article citations)', async () => {
  const body = `<p>${FILLER}</p>
            <p>参见 <a href="/other-page">站内引用</a> 的内容。</p>`;
  const text = await (await generateTxt(makeBook(body))).text();
  assert.ok(text.includes('站内引用'), 'same-domain link text kept');
});

test('keeps the article title', async () => {
  const body = `<p>${FILLER}</p>`;
  const text = await (await generateTxt(makeBook(body))).text();
  assert.ok(text.includes('Clean Article'), 'article title preserved');
});

test('keeps content after pagination marker while cleaning ads', async () => {
  const body = `<p>${FILLER}</p>
            <a href="https://ads.example.net/x"><div>广告文字</div></a>
            <!-- pagination-break -->
            <p>下一页正文。</p>`;
  const text = await (await generateTxt(makeBook(body))).text();
  assert.ok(!text.includes('广告文字'), 'ad text removed despite pagination marker');
  assert.ok(text.includes('下一页正文'), 'content after marker remains');
});
