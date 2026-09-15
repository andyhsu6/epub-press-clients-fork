// Regression guard: merged pagination must survive the TOC step.
//
// Why this file exists: extractWithPagination joins page 2..N onto page 1 with a
// literal `<!-- pagination-break -->` marker, and the TOC step (buildTocEntries ->
// detectChapterTitles) re-serializes that merged content before chapter assembly.
// Until now nothing looked inside a generated .epub to check the joins and the
// page-2+ content are still there, so a future change to the TOC step could
// silently ship only page 1 again.
//
// XML well-formedness is checked with python's expat on purpose - linkedom
// silently accepts both an unbound namespace prefix and a bare '&', and xmllint
// accepts the prefix, while real Chromium (i.e. every reader that parses these
// files) rejects both.
//
//   node --test tests/pagination-merge.node-test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, NodeFilter } from 'linkedom';
import JSZip from 'jszip';

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
// No test may reach the network: the product's own pagination fetch is served by
// the per-test stub below, and this default throws if a call is ever missed.
globalThis.fetch = async () => { throw new Error('no network in tests'); };

const { generateEpub } = await import('../scripts/generater.js');

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'toc');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8');

// The fixture pages carry relative pagenav links, which the product resolves
// against the url it was handed; this synthetic root makes every resolved url a
// plain function of the file name, so the stub can serve it from disk.
const ROOT = 'https://example.test/toc/';
const SERVABLE = /^(pag|np)-page-[123]\.html$/;
const MERGE_MARKER = '<!-- pagination-break -->';

function installFetchStub() {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const name = String(url).startsWith(ROOT) ? String(url).slice(ROOT.length) : '';
    if (SERVABLE.test(name)) {
      const body = fixture(name);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => body,
      };
    }
    return { ok: false, status: 404, headers: { get: () => 'text/plain' }, text: async () => '' };
  };
  return calls;
}

function assertWellFormed(name, xml) {
  const r = spawnSync('python3',
    ['-c', 'import sys,xml.etree.ElementTree as E;E.fromstring(sys.stdin.buffer.read())'],
    { input: Buffer.from(xml, 'utf8') });
  if (r.status !== 0) {
    const err = (r.stderr.toString() || '').trim().split('\n').pop() || 'parse failed';
    assert.fail(`${name} is not well-formed XML -> ${err}\n--- head ---\n${xml.slice(0, 260)}`);
  }
}

async function buildMerged(prefix) {
  const calls = installFetchStub();
  const blob = await generateEpub({
    title: '分页合并回归',
    includeImages: false,
    sections: [{ url: `${ROOT}${prefix}page-1.html`, html: fixture(`${prefix}page-1.html`) }],
  });
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  const files = {};
  for (const name of Object.keys(zip.files)) {
    if (name.endsWith('.xhtml')) files[name] = await zip.file(name).async('string');
  }
  return { calls, files };
}

function assertMergedChapter({ calls, files }, prefix, sentinels) {
  const chapterName = 'OEBPS/chapter2.xhtml';
  const chapter = files[chapterName];
  assert.equal(typeof chapter, 'string',
    `expected the merged article at ${chapterName}, got: ${Object.keys(files).join(', ')}`);

  const markerCount = chapter.split(MERGE_MARKER).length - 1;
  assert.equal(markerCount, 2,
    `${prefix}: expected exactly 2 '${MERGE_MARKER}' joins (3 merged pages), got ${markerCount}`);

  const present = sentinels.map((s) => chapter.includes(s));
  console.log(`[${prefix}] ${chapterName}: ${markerCount} merge markers; ` +
    sentinels.map((s, i) => `${s}=${present[i]}`).join(' '));
  sentinels.forEach((sentinel, i) => {
    assert.ok(present[i], `${prefix}: ${sentinel} did not survive into ${chapterName}`);
  });

  const afterLastMarker = chapter.slice(chapter.lastIndexOf(MERGE_MARKER) + MERGE_MARKER.length)
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.ok(afterLastMarker.length > 0, `${prefix}: no text follows the last merge marker in ${chapterName}`);

  for (const [name, xml] of Object.entries(files)) assertWellFormed(name, xml);

  assert.deepEqual(calls, [`${ROOT}${prefix}page-2.html`, `${ROOT}${prefix}page-3.html`],
    `${prefix}: findNextPageUrl did not walk page 1 -> 2 -> 3 (fetched: ${JSON.stringify(calls)})`);
}

describe('merged pagination survives the TOC step', () => {
  test('a plain 3-page article keeps pages 2 and 3 in OEBPS/chapter2.xhtml', async () => {
    assertMergedChapter(await buildMerged('pag-'), 'pag-', ['PAGE1SENTINEL', 'PAGE2SENTINEL', 'PAGE3SENTINEL']);
  });

  test('a torture-markup 3-page article keeps pages 2 and 3 in OEBPS/chapter2.xhtml', async () => {
    assertMergedChapter(await buildMerged('np-'), 'np-', ['NPSENT1', 'NPSENT2', 'NPSENT3']);
  });
});
