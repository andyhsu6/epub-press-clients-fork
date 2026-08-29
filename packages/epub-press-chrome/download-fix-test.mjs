// Node-native tests for the download fix: Browser.blobToDataUrl converts blobs
// to self-contained data URLs so chrome.downloads.download does not depend on
// the MV3 popup staying alive (blob: URLs die with the popup).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DOMParser, NodeFilter } from 'linkedom';

const require = createRequire(import.meta.url);

globalThis.chrome = {
  runtime: { lastError: null, onMessage: { addListener() {} }, onConnect: { addListener() {} }, connect() { return {}; } },
  downloads: { onChanged: { addListener() {} }, download() {} },
  scripting: {},
  windows: {},
};
globalThis.document = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');

const babel = require('@babel/core');
const fs = require('node:fs');
const src = fs.readFileSync('./scripts/browser.js', 'utf8');
const result = babel.transformSync(src, {
  filename: 'browser.js',
  presets: [['@babel/preset-env', { targets: { node: 'current' } }]],
  plugins: ['@babel/plugin-transform-modules-commonjs'],
  sourceType: 'module',
});
const moduleObj = { exports: {} };
const fn = new Function('module', 'exports', 'require', result.code);
fn(moduleObj, moduleObj.exports, require);
const Browser = moduleObj.exports.default;

test('blobToDataUrl converts a text blob to a base64 data URL', async () => {
  const blob = new Blob(['hello epubpress'], { type: 'text/plain' });
  const dataUrl = await Browser.blobToDataUrl(blob);

  assert.match(dataUrl, /^data:text\/plain;base64,/);
  const decoded = atob(dataUrl.split(',')[1]);
  assert.equal(decoded, 'hello epubpress');
});

test('blobToDataUrl round-trips non-ASCII content', async () => {
  const text = '中文内容与 emoji 🎉 测试';
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const dataUrl = await Browser.blobToDataUrl(blob);

  assert.match(dataUrl, /^data:text\/plain/);
  // base64 -> bytes -> UTF-8 text
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const decoded = new TextDecoder('utf-8').decode(bytes);
  assert.equal(decoded, text);
});
