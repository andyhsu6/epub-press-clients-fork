// Emits the level/entry snapshot of the real-page fixtures as a JS literal.
//
// Why: tests/toc.node-test.mjs asserts entry *counts* only, so a change that keeps
// the count and corrupts the hierarchy (a front-matter label promoted to the parent
// of 第一章) passes the suite. This file is the golden source for those locks;
// re-run it and commit the diff when a level change is deliberate.
//
//   node tools/toc-level-lock.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
globalThis.fetch = async () => { throw new Error('no network in fixtures'); };

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const { detectChapterTitles } = await import(join(PKG, 'scripts/toc.js'));
const { extractFromHtml } = await import('@extractus/article-extractor');

export const LOCKS = [
  ['multi-heading.html', 'https://blog.example.com/post/feng-yu-chen'],
  ['ibbs-forum-13chapters.html', 'https://www.ibbs.pro/thread/68805aecf30dda264d164fe9'],
  ['uaa-reader-h1.html', 'https://www.uaa.com/novel/chapter?id=234639'],
  ['long-title-lines.html', 'https://serial.example.com/book/7'],
  ['standalone-p-titles.html', 'https://serial.example.com/book/biancheng'],
];

const rows = [];
for (const [name, url] of LOCKS) {
  const html = readFileSync(join(PKG, 'tests', 'fixtures', 'toc', name), 'utf8');
  const article = await extractFromHtml(html, url);
  const { entries } = detectChapterTitles(article.content || '');
  rows.push({ fixture: name, url, count: entries.length, levels: entries.map((e) => e.level), texts: entries.map((e) => e.text) });
}
console.log('// paste into tests/toc-matrix.node-test.mjs — the lock must be a literal,');
console.log('// because a snapshot recomputed at test time can never fail');
console.log('const FIXTURE_LOCKS = ' + JSON.stringify(rows, null, 2).replace(/"([a-z]+)": /g, '$1: ') + ';');
