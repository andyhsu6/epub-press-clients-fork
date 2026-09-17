// Mutation gate for chapter-title detection: proves the acceptance rig can actually fail.
//
//   node tools/toc-mutation-gate.mjs            (all mutations)
//   node tools/toc-mutation-gate.mjs X8 X9      (subset)
//   node tools/toc-mutation-gate.mjs V1 V2 V3   (subset; V系 mutate generater.js, not toc.js)
//
// Why: `node --test tests/toc.node-test.mjs` reports 19/19 green while the lexical
// gate and the sentence-ending gate are deleted outright. A suite that cannot go red
// cannot approve a change either, so every rule this design adds must arrive with a
// mutation that turns at least one named case red.
//
// Run face: the three volume carry-over suites (split / carryover / e2e) are registered
// here because they are the only ones that can see the rules V1/V2 destroy — an
// unregistered suite cannot approve a change either. To show those rows really close a
// GAP (i.e. the old two suites still miss them), override the list:
//
//   TOC_GATE_SUITES=tests/toc.node-test.mjs,tests/toc-matrix.node-test.mjs \
//     node tools/toc-mutation-gate.mjs V1 V2 V3
//       -> V1/V2/V4 read 真缺口 or new-suite-only; V3 reads RED 2 (see the V系 note below)
//
// Safety: mutations are applied to a copy under .mut-shadow/ and the repo sources are
// only ever read from; scripts/{toc,generater}.js checksums are verified unchanged after
// every run, so a crashed run cannot leave a mutated source behind either.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHADOW = join(PKG, '.mut-shadow');
// Sources a mutation may target. X系 all rewrite toc.js (detection); V系 rewrite generater.js
// (buildTocEntries, i.e. the tree the reader gets), which is why the runner takes a source
// path per mutation instead of the toc.js-only assumption this file shipped with.
const TOC_SRC = 'scripts/toc.js';
const SOURCES = [TOC_SRC, 'scripts/generater.js'];
// The two suites this gate shipped with — kept named because the V系 proof needs the
// "only the old face runs" configuration, not just the full one.
const LEGACY_SUITES = ['tests/toc-matrix.node-test.mjs', 'tests/toc.node-test.mjs'];
// F2 MAJOR-2: the volume carry-over suites were the gap — they were the only ones that went
// red for V1/V2 while the gate stayed green. Registering them is what turns "the suite passes"
// into "the suite can fail", so they now run on every mutation.
const VOLUME_SUITES = [
  'tests/toc-volume-split.node-test.mjs',
  'tests/toc-volume-carryover.node-test.mjs',
  'tests/toc-volume-e2e.node-test.mjs',
];
const SUITES = (process.env.TOC_GATE_SUITES
  ? process.env.TOC_GATE_SUITES.split(/[,\s]+/).filter(Boolean)
  : [...LEGACY_SUITES, ...VOLUME_SUITES]);

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
const SRC_SHA = new Map(SOURCES.map((rel) => [rel, sha(join(PKG, rel))]));

// Each mutation names the rule it destroys. `apply` must change the text or the runner
// reports BAD rather than silently testing an unmutated copy. A 4th element selects the
// source the apply() rewrites; omitting it keeps the original toc.js-only behaviour.
const MUTATIONS = [
  ['X1', 'G1 词法准入门（toc.js:207）', (s) => s.replace('.filter((c) => c.info || c.mode === \'heading\')', '')],
  ['X2', 'G2 句末标点门（toc.js:59 定义）', (s) => s.replace(/const SENTENCE_END_RE = [^;]+;/, 'const SENTENCE_END_RE = /(?!x)x/;')],
  ['X3', 'score 中 info 的 +2', (s) => s.replace('if (cand.info) score += 2;', '')],
  ['X4', 'classify 词法全废', (s) => s.replace('function classify(text) {', 'function classify(text) { return null; // MUTANT')],
  ['X5', '复现要求序位递增', (s) => s.replace('list[i].info.ordinal > list[i - 1].info.ordinal', 'true')],
  ['X6', '短块候选长度上限', (s) => s.replace('const TITLE_MAX_LEN = 40;', 'const TITLE_MAX_LEN = 100000;')],
  ['X7', 'followedByLong 的正文长度门槛', (s) => s.replace('nextLen >= 80 && nextLen >= full.length * 4', 'true')],
  ['X8', 'UNIT_LEVEL 层级表（压平）', (s) => s.replace("const UNIT_LEVEL = { '卷': 0, '部': 0, '辑': 0, '篇': 1, '章': 1, '回': 2, '节': 3 };", 'const UNIT_LEVEL = { \'卷\': 0, \'部\': 0, \'辑\': 0, \'篇\': 0, \'章\': 0, \'回\': 0, \'节\': 0 };')],
  ['X9', 'VOCAB 中的序章/尾声', (s) => s.replace('序章|序言|', '').replace('尾声|', '')],
  ['X10', 'NOISE 噪声门', (s) => s.replace('.filter((c) => !NOISE_RE.test(c.text))', '')],
  // ── V系：卷上下文的三条规则（4 个变异，V3/V4 同点两形）（generater.js buildTocEntries），一条变异抓一条规则。
  // 双向实测（TOC_GATE_SUITES=旧两件套 → 全量五件套）：
  //   V1/V2  旧面 GREEN（真缺口）/ 新面 RED 1 — 只有卷套件抓得到，补的就是 F2 MAJOR-2 那个洞；
  //   V3     旧面也 RED 2（toc.node-test「a volume named inline on all 13 chapters stays one
  //          parent」＋「a forum page holding 13 chapters…」，即 T8 改写的那两条断言），
  //          所以它是双重覆盖而非缺口。
  //   V4     V3 的互补隔离形（只破「键变化开新父」）：实测旧面 GREEN／新面 RED 11
  //          （含 A→B→A），补的正是 V3 抓不到的那一半——两形并存各抓一半规则。
  ['V1', '兜底条目继承卷内层级（generater.js:572）',
    (s) => s.replace('const fbLevel = currentVolume ? currentVolume.childLevel : 0;', 'const fbLevel = 0;'),
    'scripts/generater.js'],
  ['V2', '跨 host 不再清空白卷上下文（generater.js:566）',
    (s) => s.replace('            currentVolume = null; // different host → clear context',
      '            // MUTANT: host 换了也不清上下文'),
    'scripts/generater.js'],
  ['V3', '卷去重即每次新建父节点（generater.js:581）',
    (s) => s.replace('if (!currentVolume || currentVolume.key !== split.volumeKey) {', 'if (true) { // MUTANT'),
    'scripts/generater.js'],
  ['V4', '键变化不开新父：仅无上下文时建父（generater.js:581 的另一半）',
    (s) => s.replace('if (!currentVolume || currentVolume.key !== split.volumeKey) {', 'if (!currentVolume) { // MUTANT'),
    'scripts/generater.js'],
];

// Guards that provably carry no independent weight today, with the arithmetic that makes
// them redundant. A documented gap becoming covered is also a finding: it means the guard
// just turned load-bearing and its killer must be kept.
const EXPLAINED_UNCONSTRAINED = {
  X1: '无 marker 的候选分数上界 = followedByLong(2)+shortBlock(1) = 3 < min 4，故准入门与分数下界重合',
  X5: 'toc.js:186 已把非递增组塌成 size=1，递增判据在 strong 单发也能过 min 4 的前提下不承重',
  X6: '超标题行走 firstLine(<br>) 通道，5 个真实 fixture 对此上限无差异',
};

function setup() {
  rmSync(SHADOW, { recursive: true, force: true });
  mkdirSync(SHADOW, { recursive: true });
  for (const d of ['scripts', 'tests', 'tools']) cpSync(join(PKG, d), join(SHADOW, d), { recursive: true });
  writeFileSync(join(SHADOW, 'package.json'), JSON.stringify({ type: 'module' }));
  // 复制面自检：V系 要改的是 scripts/generater.js（由上面的目录整体复制带进来），卷套件读的
  // 是 tests/fixtures/toc/ 下的 192KB e2e fixture。任一项没落地，变异就打在空处，
  // 宁可在这里立刻死掉，也不要产出一个假 GREEN/假 RED。
  for (const rel of [...SOURCES, join('tests', 'fixtures', 'toc')]) {
    if (!existsSync(join(SHADOW, rel))) throw new Error(`影子缺 ${rel} — 变异面不完整，结果不可信`);
  }
}

function runTests() {
  // maxBuffer: a volume-suite deepEqual over 216 nodes is orders of magnitude above the
  // 1 MB default, and a truncated stdout loses the "ℹ fail N" line — which would come back
  // as NaN and read as "survived". Raised well past the worst measured dump instead.
  const r = spawnSync('node', ['--test', ...SUITES], { cwd: SHADOW, encoding: 'utf8', maxBuffer: 64e6 });
  const out = (r.stdout || '') + (r.stderr || '');
  const fail = Number((out.match(/ℹ fail (\d+)/) || [0, '?'])[1]);
  const ids = [...new Set((out.match(/\b(?:T\d\d|N\d\d|A\d\d)\b/g) || []))].sort();
  const fixtures = [...new Set((out.match(/[\w-]+\.html 条目数变了|[\w-]+\.html 层级变了/g) || []))];
  // The volume suites name their cases in prose ("(a) a title-less page lands at the child
  // level …"), not with a T/N id, so the spec reporter's indented ✖ lines are what tie a
  // RED back to the rule. Suite rows print ✖ unindented and are excluded by the indent.
  const names = [...new Set((out.match(/^[ \t]+✖\s+[^\n]+?\s+\([\d.]+m?s\)$/gm) || [])
    .map((l) => l.replace(/^[ \t]+✖\s+/, '')))];
  return { fail, ids, fixtures, names, out };
}

// Shadow-side writers. resetShadow() re-copies every registered source from the repo so one
// mutation never inherits the previous one's text.
function writeShadow(rel, text) { writeFileSync(join(SHADOW, rel), text); }
function resetShadow() { for (const rel of SOURCES) writeShadow(rel, readFileSync(join(PKG, rel), 'utf8')); }

const only = process.argv.slice(2).filter((a) => /^[XV]\d+$/.test(a));
setup();
resetShadow();
const base = runTests();
// A missing "ℹ fail" line is NaN, not 0: that means the output got cut off, and reading it
// as "baseline green" would let every later mutation report a false RED-free run.
if (!(base.fail === 0)) {
  console.error('基线就不绿（或输出被截断，fail 行数不到），变异结果无从比较：\n'
    + base.out.split('\n').slice(-40).join('\n'));
  rmSync(SHADOW, { recursive: true, force: true });
  process.exit(1);
}
console.log(`运行面：${SUITES.join(' + ')}`);
console.log(`基线：${SUITES.length} 个套件全绿（fail=0）${process.env.TOC_GATE_SUITES ? '　← TOC_GATE_SUITES 覆盖了默认清单' : ''}\n`);
console.log('变异   被破坏的规则                              结果    抓到它的用例');
console.log('─'.repeat(100));

let holes = 0;
let newlyCovered = [];
for (const [id, label, apply, rel = TOC_SRC] of MUTATIONS) {
  if (only.length && !only.includes(id)) continue;
  resetShadow();
  const original = readFileSync(join(PKG, rel), 'utf8');
  const mutated = apply(original);
  if (mutated === original) {
    console.log(`${id.padEnd(5)}  ${label.padEnd(38)} BAD      锚点没命中（${rel}），变异根本没落地（不可当作已验证）`);
    holes += 1;
    continue;
  }
  writeShadow(rel, mutated);
  const r = runTests();
  // 卷套件的用例没有 T/N 编号，靠散文用例名归属；名字太长，截断后放进结果列。
  // 顺序有讲究：✖ 名一定是失败的那条，而 T/N 号也会从通过的矩阵行里刮出来，放前面就会
  // 把真正抓到的用例挤出 6 格窗口。
  const shortName = (n) => (n.length > 42 ? `${n.slice(0, 42)}…` : n);
  const attribution = [...r.names.map(shortName), ...r.ids, ...r.fixtures].slice(0, 6).join(', ') || '—';
  const reason = EXPLAINED_UNCONSTRAINED[id];
  let verdict;
  if (r.fail) {
    verdict = `RED  ${String(r.fail).padStart(2)}  ${attribution}`;
    if (reason) newlyCovered.push(`${id}（原记为冗余守卫，现已有杀手，保留它）`);
  } else if (reason && !process.env.TOC_GATE_STRICT) {
    verdict = `GREEN      冗余守卫，无杀手属预期：${reason}`;
  } else {
    verdict = reason ? 'GREEN      真缺口（冗余登记在 TOC_GATE_STRICT 下按缺口计）' : 'GREEN      真缺口：该规则改了没人发现';
    holes += 1;
  }
  console.log(`${id.padEnd(5)}  ${label.padEnd(38)} ${verdict}`);
}

setupCleanup();
function setupCleanup() {
  resetShadow();
  const untouched = SOURCES.filter((rel) => sha(join(PKG, rel)) === SRC_SHA.get(rel));
  const documented = Object.keys(EXPLAINED_UNCONSTRAINED).length;
  for (const rel of SOURCES) {
    const same = sha(join(PKG, rel)) === SRC_SHA.get(rel);
    console.log(`源文件校验：${rel} ${same ? '未被触碰 ✓' : '被改动了 ✗ 立刻检查'}`
      + `　shadow/${rel} == repo ? ${sha(join(SHADOW, rel)) === SRC_SHA.get(rel) ? 'true' : 'FALSE'}`);
  }
  rmSync(SHADOW, { recursive: true, force: true });
  for (const line of newlyCovered) console.log(`状态变化：${line}`);
  console.log(`真缺口 ${holes} 个，已登记的冗余守卫 ${documented} 个`);
  process.exit(untouched.length === SOURCES.length && holes === 0 ? 0 : 1);
}
