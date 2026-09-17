// Unit tests for splitVolumeEntry — the inline volume-prefix splitter.
//
//   node --test tests/toc-volume-split.node-test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitVolumeEntry } from '../scripts/toc.js';

describe('splitVolumeEntry decision table', () => {
  test('seq: with volume+chapter markers, arabic vs cn ordinal get the same key', () => {
    const hua = splitVolumeEntry('第一卷太后篇第一章', 'seq:卷章');
    const one = splitVolumeEntry('第1卷太后篇第二十一章', 'seq:卷章');

    assert.equal(hua.volumeText, '第一卷太后篇');
    assert.equal(hua.chapterText, '第一章');
    assert.equal(hua.volumeKey, '卷|1|太后篇');

    assert.equal(one.volumeText, '第1卷太后篇');
    assert.equal(one.chapterText, '第二十一章');
    assert.equal(one.volumeKey, '卷|1|太后篇');

    // same key → same volume parent
    assert.equal(hua.volumeKey, one.volumeKey);
  });

  test('multi-volume-marker prefix uses the last volume marker', () => {
    const r = splitVolumeEntry('第一部 第二卷 第一章', 'seq:卷章');
    assert.equal(r.volumeKey, '卷|2|第一部');
    assert.equal(r.volumeText, '第一部 第二卷');
    assert.equal(r.chapterText, '第一章');
  });

  test('pian-level split (篇 as volume, 章 as chapter)', () => {
    const r = splitVolumeEntry('第二篇 雪上伤篇 第一章', 'seq:篇章');
    assert.equal(r.volumeText, '第二篇 雪上伤篇');
    assert.equal(r.chapterText, '第一章');
    assert.equal(r.volumeKey, '篇|2|雪上伤篇');
  });

  test('bare chapter with no volume prefix → null (table row 3)', () => {
    assert.equal(splitVolumeEntry('第五十一章', 'seq:章'), null);
    assert.equal(splitVolumeEntry('第七十六章', 'seq:章'), null);
  });

  test('chapter marker without volume-level prefix → null (table row 2/4)', () => {
    assert.equal(splitVolumeEntry('第二篇 雪上伤篇', 'seq:篇'), null);
    assert.equal(splitVolumeEntry('第1卷太后篇', 'seq:卷'), null);
  });

  test('non-seq kind → null (table row 1)', () => {
    assert.equal(splitVolumeEntry('一、离乡', 'number'), null);
    assert.equal(splitVolumeEntry('References', null), null);
    assert.equal(splitVolumeEntry('some heading', 'heading'), null);
  });

  test('chapter marker with non-volume prefix char → null', () => {
    assert.equal(splitVolumeEntry('?第二章', 'seq:章'), null);
  });

  test('long mixed label with extra after chapter title', () => {
    const r = splitVolumeEntry('第三篇 月下仙篇 番外卷淡黛嫣然 第一章夏日', 'seq:篇章');
    assert.equal(r.volumeText, '第三篇 月下仙篇 番外卷淡黛嫣然');
    assert.equal(r.chapterText, '第一章夏日');
    assert.equal(r.volumeKey, '篇|3|月下仙篇 番外卷淡黛嫣然');
  });
});
