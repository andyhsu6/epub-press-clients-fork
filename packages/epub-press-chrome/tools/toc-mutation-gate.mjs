// Mutation gate for chapter-title detection: proves the acceptance rig can actually fail.
//
//   node tools/toc-mutation-gate.mjs            (all mutations)
//   node tools/toc-mutation-gate.mjs X8 X9      (subset)
//
// Why: `node --test tests/toc.node-test.mjs` reports 19/19 green while the lexical
// gate and the sentence-ending gate are deleted outright. A suite that cannot go red
// cannot approve a change either, so every rule this design adds must arrive with a
// mutation that turns at least one named case red.
//
// Safety: mutations are applied to a copy under .mut-shadow/. scripts/toc.js is
// untracked in git, so an in-place rewrite could not be reverted; its checksum is
// verified unchanged after every run.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHADOW = join(PKG, '.mut-shadow');
const SRC = join(PKG, 'scripts', 'toc.js');
const SUITES = ['tests/toc-matrix.node-test.mjs', 'tests/toc.node-test.mjs'];

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
const SRC_SHA = sha(SRC);

// Each mutation names the rule it destroys. `apply` must change the text or the runner
// reports BAD rather than silently testing an unmutated copy.
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
}

function runTests() {
  const r = spawnSync('node', ['--test', ...SUITES], { cwd: SHADOW, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const fail = Number((out.match(/ℹ fail (\d+)/) || [0, '?'])[1]);
  const ids = [...new Set((out.match(/\b(?:T\d\d|N\d\d|A\d\d)\b/g) || []))].sort();
  const fixtures = [...new Set((out.match(/[\w-]+\.html 条目数变了|[\w-]+\.html 层级变了/g) || []))];
  return { fail, ids, fixtures, out };
}

function writeToc(text) { writeFileSync(join(SHADOW, 'scripts', 'toc.js'), text); }

const only = process.argv.slice(2).filter((a) => /^X\d+$/.test(a));
setup();
writeToc(readFileSync(SRC, 'utf8'));
const base = runTests();
if (base.fail !== 0) {
  console.error('基线就不绿，变异结果无从比较：\n' + base.out.split('\n').slice(-40).join('\n'));
  process.exit(1);
}
console.log(`基线：${SUITES.join(' + ')} 全绿（fail=0）\n`);
console.log('变异   被破坏的规则                              结果    抓到它的用例');
console.log('─'.repeat(100));

let holes = 0;
let newlyCovered = [];
for (const [id, label, apply] of MUTATIONS) {
  if (only.length && !only.includes(id)) continue;
  const original = readFileSync(SRC, 'utf8');
  const mutated = apply(original);
  if (mutated === original) {
    console.log(`${id.padEnd(5)}  ${label.padEnd(38)} BAD      锚点没命中，变异根本没落地（不可当作已验证）`);
    holes += 1;
    continue;
  }
  writeToc(mutated);
  const r = runTests();
  const attribution = [...r.ids, ...r.fixtures].slice(0, 6).join(', ') || '—';
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
  writeToc(readFileSync(SRC, 'utf8'));
  const same = sha(SRC) === SRC_SHA;
  const documented = Object.keys(EXPLAINED_UNCONSTRAINED).length;
  console.log(`\n源文件校验：scripts/toc.js ${same ? '未被触碰 ✓' : '被改动了 ✗ 立刻检查'}`);
  console.log(`shadow/scripts/toc.js == repo ? ${sha(join(SHADOW, 'scripts', 'toc.js')) === SRC_SHA ? 'true' : 'FALSE'}`);
  rmSync(SHADOW, { recursive: true, force: true });
  for (const line of newlyCovered) console.log(`状态变化：${line}`);
  console.log(`真缺口 ${holes} 个，已登记的冗余守卫 ${documented} 个`);
  process.exit(same && holes === 0 ? 0 : 1);
}
