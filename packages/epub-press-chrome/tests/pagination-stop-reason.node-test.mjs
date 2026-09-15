// Pagination stop-reason observability tests.
//
// Why this file exists: extractWithPagination used to discard every reason it
// stopped (HTTP status, duplicate page, empty extraction, fetch error), which is
// what made the 2026-09-15 "only page 1" report impossible to diagnose. These
// tests pin the recorded outcome (`book.pagination`) for each transport/content
// exit that can end pagination on the FIRST next-page fetch.
//
//   node --test tests/pagination-stop-reason.node-test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, NodeFilter } from 'linkedom';

class BrowserLikeDOMParser extends DOMParser {
  parseFromString(html, type) {
    if (type === 'text/html' && typeof html === 'string' && !/^\s*(<!DOCTYPE|<html)/i.test(html)) {
      return super.parseFromString(`<html><body>${html}</body></html>`, type);
    }
    return super.parseFromString(html, type);
  }
}
globalThis.DOMParser = BrowserLikeDOMParser;
globalThis.NodeFilter = NodeFilter;
globalThis.XMLSerializer = class { serializeToString(node) { return node.toString(); } };
// Every test installs its own stub before exporting; this default makes an
// un-stubbed fetch fail loudly instead of reaching the network.
globalThis.fetch = async () => { throw new Error('no network in tests'); };

const { generateEpub, generateTxt } = await import('../scripts/generater.js');

const ROOT_URL = 'https://example.com/book/spring-tide.html';
const NEXT_URL = 'https://example.com/book/spring-tide-2.html';
const NEXT_HREF = 'spring-tide-2.html';

const PROSE = '他站在天台的边缘往下看，整座城市的灯火像打翻的棋局，横竖都没有尽头。风从海面过来，带着咸味和一点点铁锈气，把他手里那页纸吹得哗哗作响。上面只有一行字，是他父亲留下的全部东西，也是他花了七年才敢重新读一遍的东西。';

function page({ title = '春潮', next = NEXT_HREF } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
${next ? `<link rel="next" href="${next}">` : ''}
</head><body>
<div id="readabilityPage"><h1>${title}</h1><p>${PROSE}</p><p>${PROSE}</p><p>${PROSE}</p></div>
</body></html>`;
}

function newBook(html) {
  return { title: 'Test Book', includeImages: false, sections: [{ url: ROOT_URL, html }] };
}

// Response-shaped stub: only the fields extractWithPagination reads.
const response = (status, text) => ({ ok: status >= 200 && status < 300, status, text: async () => text });

describe('pagination stop reasons are recorded', () => {
  test('a failed next-page fetch records http-error with the real status, fetch-failed with the message, timeout for an AbortError', async () => {
    globalThis.fetch = async () => response(404, 'not found');
    const httpBook = newBook(page());
    const blob = await generateEpub(httpBook);
    assert.ok(blob && typeof blob.size === 'number', 'generateEpub must keep returning a Blob');
    assert.equal(httpBook.pagination.length, 1, 'one record per section');
    const http = httpBook.pagination[0];
    assert.equal(http.stopReason, 'http-error', `got ${JSON.stringify(http)}`);
    assert.equal(http.status, 404, `the real status must be captured, got ${JSON.stringify(http)}`);
    assert.equal(http.pagesMerged, 1);
    assert.equal(http.lastUrl, NEXT_URL, 'lastUrl is the last URL attempted');
    assert.equal(http.sectionUrl, ROOT_URL);
    assert.equal(http.sectionIndex, 0);
    assert.equal(http.title, '春潮');

    globalThis.fetch = async () => { throw new Error('boom'); };
    const boomBook = newBook(page());
    await generateEpub(boomBook);
    const boom = boomBook.pagination[0];
    assert.equal(boom.stopReason, 'fetch-failed', `got ${JSON.stringify(boom)}`);
    assert.ok(String(boom.error).includes('boom'), `error must carry the message, got ${JSON.stringify(boom)}`);

    globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    const timeoutBook = newBook(page());
    await generateEpub(timeoutBook);
    assert.equal(timeoutBook.pagination[0].stopReason, 'timeout', `got ${JSON.stringify(timeoutBook.pagination[0])}`);
  });

  test('a next page identical to the previous page records duplicate-page', async () => {
    const html = page();
    globalThis.fetch = async () => response(200, html);
    const book = newBook(html);
    await generateEpub(book);
    const rec = book.pagination[0];
    assert.equal(rec.stopReason, 'duplicate-page', `got ${JSON.stringify(rec)}`);
    assert.equal(rec.pagesMerged, 1);
    assert.equal(rec.status, 200);
  });

  test('a next page that yields no article records empty-page', async () => {
    globalThis.fetch = async () => response(200, '<html><body><div>no article here</div></body></html>');
    const book = newBook(page());
    await generateEpub(book);
    const rec = book.pagination[0];
    assert.equal(rec.stopReason, 'empty-page', `got ${JSON.stringify(rec)}`);
    assert.equal(rec.status, 200);
    assert.equal(rec.pagesMerged, 1);
  });

  test('a single-page article completes without fetching, and TXT export still returns a Blob', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error('single-page article must not fetch'); };
    const book = newBook(page({ next: null }));
    const blob = await generateTxt(book);
    assert.equal(fetchCalls, 0, 'no next link -> fetch must never be called');
    assert.ok(blob instanceof Blob, 'generateTxt must keep returning a Blob');
    const rec = book.pagination[0];
    assert.equal(rec.stopReason, 'complete', `got ${JSON.stringify(rec)}`);
    assert.equal(rec.pagesMerged, 1);
    assert.equal(rec.lastUrl, ROOT_URL, 'nothing attempted -> lastUrl is the section url');
    assert.equal(rec.status, null);
    assert.equal(rec.error, null);
  });
});
