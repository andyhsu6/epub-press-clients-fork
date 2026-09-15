// Acceptance rig for chapter-title detection: shape matrix + real-page level locks.
//
//   node --test tests/toc-matrix.node-test.mjs
//   TOC_MATRIX_UPDATE=1 node tests/toc-matrix.node-test.mjs   (print the ACTUAL table)
//
// Why this file exists separately from toc.node-test.mjs: that suite asserts entry
// *counts* and nothing about which <p> shapes are reachable. Mutation runs proved it
// stays fully green with the lexical gate and the sentence-ending gate both deleted,
// so it cannot constrain any change made to them. Cases here declare `want` (the
// behaviour the design promises) and `got` (what today's code really does); any drift
// in either direction fails, and unimplemented rows must be listed in PENDING.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

// ─── Follow-through bands ────────────────────────────────────────────────────
// Every earlier measurement of this detector used one band only (a 160-char body
// after each title), which makes `followedByLong` unconditionally true and inflates
// recall. The band is therefore a matrix dimension, and its sizes are pinned here.
const LONG = '他缓缓抬起头，目光越过层层叠叠的人群，落在那扇半掩的木门上。屋子里安静得能听见尘埃落地的声音，而门后的秘密已经沉睡了整整三百年，没有人知道它究竟在等待谁来唤醒它。'.repeat(2);
const MID = '他缓缓抬起头，目光越过层层叠叠的人群，落在那扇半掩的木门上。屋子里安静得能听见尘埃落地的声音。';
const SIBLING = '另有一行短字跟着';

assert.ok(SIBLING.length <= 40, `SIBLING must itself stay a candidate block, got ${SIBLING.length}`);

const BODY = { long: LONG, mid: MID, sibling: SIBLING };

// The design defines "body" structurally: a neighbour longer than the candidate cap
// (scripts/toc.js TITLE_MAX_LEN) cannot itself be a title, so it is body. The bands are
// pinned against that same number — retune the cap without re-checking the bands and
// MID silently stops meaning what its name says.
const CANDIDATE_CAP = 40;
assert.ok(MID.length > CANDIDATE_CAP, `MID 必须刚过候选上限，用来压 nextIsBody 的边界：${MID.length}`);
assert.ok(LONG.length >= CANDIDATE_CAP * 3, `LONG 必须稳在正文侧，got ${LONG.length}`);

function page(titles, band) {
  return titles.map((t) => (t.html || `<p>${t.text ?? t}</p>`) + `<p>${BODY[band]}</p>`).join('\n');
}

// ─── Cases ───────────────────────────────────────────────────────────────────
// want.count   expected number of TOC entries
// want.levels  expected level sequence (optional; locks hierarchy, not just membership)
// band         which follow-through the title is placed before
// note         why the row exists / what accepted cost it documents
const CASES = [
  // strong: unit word present
  { id: 'T01', titles: ['第一章'], band: 'long', want: { count: 1 } },
  { id: 'T02', titles: ['第一章'], band: 'mid', want: { count: 1 }, note: '无 followedByLong 时 strong 仍须入选' },
  { id: 'T03', titles: ['第一章'], band: 'sibling', want: { count: 1 } },
  { id: 'T04', titles: ['第01章'], band: 'mid', want: { count: 1 } },
  { id: 'T05', titles: ['第一部', '第一回　我的童年', '第二回　我的少年'], band: 'long', want: { count: 3, levels: [0, 2, 2] } },
  // ordinal-only: bracketed numeral plus label
  { id: 'T06', titles: ['（一）秘藏的手稿'], band: 'long', want: { count: 1 } },
  { id: 'T07', titles: ['（一）秘藏的手稿'], band: 'mid', want: { count: 1 } },
  { id: 'T08', titles: ['（一）秘藏的手稿', '（二）门后的影子', '（三）三百年的等待'], band: 'sibling', want: { count: 3 } },
  // bare: bracketed numeral only — needs frame plus a rising run
  { id: 'T09', titles: ['（零）', '（一）', '（二）'], band: 'long', want: { count: 3 } },
  { id: 'T10', titles: ['（上）', '（下）'], band: 'long', want: { count: 2 } },
  { id: 'T11', titles: ['（A）', '（B）'], band: 'long', want: { count: 2 } },
  { id: 'T12', titles: ['（甲）', '（乙）', '（丙）'], band: 'long', want: { count: 3 } },
  { id: 'T13', titles: ['（i）', '（ii）', '（iii）'], band: 'long', want: { count: 3 } },
  // decoration-wrapped
  { id: 'T14', titles: ['第一章（上）', '第二章（上）', '第三章（上）'], band: 'long', want: { count: 3 } },
  { id: 'T15', titles: ['～序～'], band: 'long', want: { count: 1 } },
  { id: 'T16', titles: ['序'], band: 'mid', want: { count: 1 } },
  { id: 'T17', titles: ['【序言】', '◆楔子◆'], band: 'long', want: { count: 2 } },
  { id: 'T18', titles: ['「序」'], band: 'long', want: { count: 1 }, note: '引号作 frame 仅限整行包裹且 strong' },
  // nesting: bracketed run sitting under a chapter
  { id: 'T19', titles: ['第一章　秘藏的手稿', '（一）', '（二）', '第二章　门后的影子', '（一）', '（二）'], band: 'long', want: { count: 6, levels: [1, 2, 2, 1, 2, 2] }, note: '序位回绕 ⇒ 子系列，需全书作用域' },
  { id: 'T20', titles: ['第一部', '（一）秘藏', '（二）门后', '第二部', '（一）远方'], band: 'long', want: { count: 5, levels: [0, 1, 1, 0, 1] } },
  // length must not break a run (lenBand must not be part of identity)
  { id: 'T21', titles: ['（一）秘藏的手稿', '（二）门后的影子', '（三）他终于明白这一切都不是偶然发生的'], band: 'long', want: { count: 3, levels: [1, 1, 1] } },

  // ─── negatives: must never be promoted ───
  { id: 'N01', titles: ['（未完）', '（未完待续）'], band: 'long', want: { count: 0 }, note: '框内非序位 token；未 是地支，故不能只靠封闭集' },
  { id: 'N02', titles: ['上级的指示，第二天才传达下来。'], band: 'long', want: { count: 0 } },
  { id: 'N03', titles: ['（一）他推开门，看见一个人站在灯下。'], band: 'long', want: { count: 0 }, note: '硬收尾标点即使有 marker 也不豁免' },
  { id: 'N04', titles: ['【一】那年冬天，雪下得格外地早。'], band: 'long', want: { count: 0 } },
  { id: 'N05', titles: ['上', '下', '中'], band: 'long', want: { count: 0 }, note: '无框单字封闭集成员永不入选' },
  { id: 'N06', titles: ['「驾！」', '「将军！」', '「你来了。」', '「走吧。」'], band: 'long', want: { count: 0 } },
  { id: 'N07', titles: ['「一」', '「二」', '「三」'], band: 'long', want: { count: 0 }, note: '引号里的 bare 不算标题' },
  { id: 'N08', titles: ['分享', '加入书签', '返回列表', '目录'], band: 'long', want: { count: 0 } },
  { id: 'N09', titles: ['2019'], band: 'long', want: { count: 0 } },
  { id: 'N10', titles: ['A 计划失败以后，B 也没有回来。'], band: 'long', want: { count: 0 } },
  { id: 'N11', titles: ['3. 他走了很远才回到家里。'], band: 'long', want: { count: 0 } },
  { id: 'N12', titles: ['下意识地，他往后退了半步。'], band: 'long', want: { count: 0 } },
  // 只有"带序号的导航行"才能约束 NOISE 门：无序号的 下一页/加入书签 本来就被词法门挡住，
  // 删掉 NOISE 门也不会有任何用例变红，那是两道守卫冗余而不是守卫有效。
  { id: 'N13', titles: ['下一页：第三章', '返回目录：第一章'], band: 'long', want: { count: 0 } },
  // 复现分组要求序位递增：序值一动不动的同形裸标记不成组
  { id: 'N14', titles: ['（一）', '（一）', '（一）'], band: 'long', want: { count: 0 } },

  // ─── accepted cost, recorded so its size is known rather than hoped for ───
  { id: 'A01', titles: ['（一）加强组织领导', '（二）明确工作责任', '（三）强化督促检查'], band: 'long',
    want: { count: 3 }, cost: true, note: '宁多勿漏裁定下接受为误报；罚分只能降低概率，不能消除' },
];

// Rows whose current behaviour differs from the table above. Targets are work still to
// do; `cost` rows are the price the design agrees to pay once the bracket family is
// admitted. Either direction moving without the table moving too is a failure.
const PENDING = ['T02', 'T03', 'T04', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'T13', 'T14',
  'T15', 'T16', 'T17', 'T18', 'T19', 'T20', 'T21', 'A01'];

function outcome(c) {
  const { entries } = detectChapterTitles(page(c.titles, c.band));
  return { count: entries.length, levels: entries.map((e) => e.level), texts: entries.map((e) => e.text) };
}

const actual = new Map(CASES.map((c) => [c.id, outcome(c)]));

if (process.env.TOC_MATRIX_UPDATE) {
  const table = CASES.map((c) => ({ id: c.id, band: c.band, got: actual.get(c.id).count, levels: actual.get(c.id).levels, texts: actual.get(c.id).texts }));
  console.log('// ACTUAL under current scripts/toc.js');
  console.log(JSON.stringify(table, null, 1));
  console.log('PENDING candidates (got !== want): '
    + CASES.filter((c) => actual.get(c.id).count !== c.want.count).map((c) => c.id).join(','));
}

test('每个形状矩阵用例的实际结果必须落在 want 或已登记的 PENDING 之内', () => {
  const drift = [];
  const stillPending = [];
  const goalRows = [];
  const costRows = [];
  for (const c of CASES) {
    const got = actual.get(c.id);
    const matchesWant = got.count === c.want.count
      && (!c.want.levels || JSON.stringify(got.levels) === JSON.stringify(c.want.levels));
    if (matchesWant) {
      if (PENDING.includes(c.id)) drift.push(`${c.id} 已通过但仍挂在 PENDING 上，请从表中删除（毕业需显式动作）`);
    } else if (PENDING.includes(c.id)) {
      stillPending.push(`${c.id}[${c.band}] 期望 ${JSON.stringify(c.want)} 实得 ${got.count} 条 ${JSON.stringify(got.texts)}`);
      (c.cost ? costRows : goalRows).push(c.id);
    } else {
      drift.push(`${c.id}[${c.band}] 未登记就坏了：期望 ${JSON.stringify(c.want)} 实得 ${got.count} 条 ${JSON.stringify(got.texts)}`);
    }
  }
  assert.deepEqual(drift, [], `与登记表不符：\n${drift.join('\n')}`);
  console.log(`  矩阵 ${CASES.length} 条：待实现目标 ${goalRows.length} [${goalRows.join(',')}]，已登记代价 ${costRows.length} [${costRows.join(',')}]，其余为锁`);
});

// Golden values captured from the current scripts/toc.js via
// `node tools/toc-level-lock.mjs`. They must stay literals: a snapshot recomputed at
// test time agrees with itself and can never fail. Regenerate and commit the diff only
// when a level change is intended.
const FIXTURE_LOCKS = [
  { fixture: 'multi-heading.html', count: 7, levels: [0, 1, 1, 1, 2, 3, 1] },
  { fixture: 'ibbs-forum-13chapters.html', count: 13, levels: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  { fixture: 'uaa-reader-h1.html', count: 0, levels: [] },
  { fixture: 'long-title-lines.html', count: 4, levels: [1, 1, 1, 1] },
  { fixture: 'standalone-p-titles.html', count: 4, levels: [1, 1, 1, 1] },
];

const LOCK_URLS = {
  'multi-heading.html': 'https://blog.example.com/post/feng-yu-chen',
  'ibbs-forum-13chapters.html': 'https://www.ibbs.pro/thread/68805aecf30dda264d164fe9',
  'uaa-reader-h1.html': 'https://www.uaa.com/novel/chapter?id=234639',
  'long-title-lines.html': 'https://serial.example.com/book/7',
  'standalone-p-titles.html': 'https://serial.example.com/book/biancheng',
};

// toc.node-test.mjs asserts counts, so promoting 序章 from level 1 to 0 — which makes
// it the parent of 第一章 in the reader outline — is invisible there.
test('真实页面的层级序列不得被静默改写', async () => {
  for (const lock of FIXTURE_LOCKS) {
    const html = readFileSync(join(PKG, 'tests', 'fixtures', 'toc', lock.fixture), 'utf8');
    const article = await extractFromHtml(html, LOCK_URLS[lock.fixture]);
    const { entries } = detectChapterTitles(article.content || '');
    const got = entries.map((e) => e.level);
    assert.equal(entries.length, lock.count, `${lock.fixture} 条目数变了：${JSON.stringify(entries.map((e) => e.text))}`);
    assert.deepEqual(got, lock.levels, `${lock.fixture} 层级变了：${JSON.stringify(got)} 应为 ${JSON.stringify(lock.levels)}，条目 ${JSON.stringify(entries.map((e) => e.text))}`);
  }
});
