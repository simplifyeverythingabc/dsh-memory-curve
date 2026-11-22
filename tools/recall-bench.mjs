/**
 * 记忆召回基准（0.16.0）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * 这个插件跑了十几个版本，一直在量**成本**：注入多少 token、build 多少毫秒、
 * 索引多大。**从来没量过效果** —— 它到底记住了没有。
 *
 * 有人看完仓库说「不装」，理由里没有一条是说它「召回不准」，因为没人知道准不准，
 * 包括我自己。这本身就是问题：一个记忆系统不测召回，等于没有验收标准。
 *
 * 对比一下外面的数据：
 *   · SuperLocalMemory V3.3   LoCoMo 70.4%（零 LLM）
 *   · Mem0                    LoCoMo 92.5%，平均 6956 token
 * 我这边一个数都没有。
 *
 * ── 这个基准怎么做 ──────────────────────────────────────────────────
 *
 * 不用人工标注，从自己的真实语料里自动生成题目：
 *
 *   1. 把全部消息切成词（复用 events.js 的 tokens，二元切词）
 *   2. 统计词频，挑出**罕见词**（出现 2~8 次）—— 太常见没有区分度，
 *      只出现一次又变成「唯一串匹配」，测不出真本事
 *   3. 每个罕见词挑一条包含它的消息当**期望答案**
 *   4. 拿这个词当查询跑 searchAll
 *   5. 看期望的那条消息排在第几位
 *
 * ── 指标 ────────────────────────────────────────────────────────────
 *
 *   Top-1 / Top-3 / Top-5   命中率：期望的那条在不在前三/前五
 *   MRR                     平均倒数排名，越接近 1 越好
 *   零命中                   一条都没搜到的比例 —— 这个最该是 0
 *
 * ── 这个基准测不到什么（重要） ──────────────────────────────────────
 *
 * 它测的是**词面召回**，不是语义召回。问「上次那个做动画的插件」而原文写的是
 * 「animation lib」，这里判它失败，但合格的人能想起来。
 *
 * 所以这是个**下限**，不是上限。真的语义召回得靠人出题，那部分只能手工做。
 *
 * 跑：node tools/recall-bench.mjs [--samples 40]
 */
import { readEntries, tokens, clearEntryCache } from '../src/events.js';
import { searchAll, listDays } from '../src/digest.js';
import { resolveMemDir, dshHome } from '../src/paths.js';
import { join } from 'node:path';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};

const SAMPLES = Math.max(10, Math.min(200, argOf('samples', 40)));
const MIN_FREQ = 2;      // 只出现一次的词 = 唯一串，测不出召回
const MAX_FREQ = 8;      // 太常见没有区分度

const memDir = resolveMemDir();
const digestDir = join(dshHome(), 'memory-notes', '_digest');

clearEntryCache();
const entries = readEntries(memDir);
if (!entries.length) {
  console.log('  语料为空，没什么可测的');
  process.exit(0);
}

// ── 1. 建词频索引：词 → 出现在哪几条消息 ──────────────────────────────
const byWord = new Map();
for (const e of entries) {
  if (!e.text) continue;
  const toks = new Set();
  for (const t of tokens(e.text)) {
    if (t.length < 2) continue;          // 单字没有区分度
    toks.add(t);
  }
  for (const t of toks) {
    if (!byWord.has(t)) byWord.set(t, []);
    byWord.get(t).push(e);
  }
}

// ── 2. 挑罕见词 ───────────────────────────────────────────────────────
const rare = [];
for (const [w, list] of byWord) {
  if (list.length < MIN_FREQ || list.length > MAX_FREQ) continue;
  rare.push({ word: w, list });
}
// 均匀抽样，避免全挤在语料尾部（近期的词天然更容易被命中）
rare.sort((a, b) => (a.word < b.word ? -1 : 1));
const step = Math.max(1, Math.floor(rare.length / SAMPLES));
const picked = [];
for (let i = 0; i < rare.length && picked.length < SAMPLES; i += step) picked.push(rare[i]);

// ── 3. 跑检索 ─────────────────────────────────────────────────────────
//
// 两组题，差别很大，不能混着报：
//
//   A 组「单词」：拿罕见词搜它自己。**这一组虚高** —— 那个词全语料只出现
//     2~8 次，搜它等于唯一串匹配，几乎必然命中。测的是「原文还在不在」，
//     不是「找不找得到」。
//
//   B 组「多词」：从同一条消息里另取一个有区分度的词，配成两词查。用户真实提问就是这样
//     （「那个 bge 模型的 token 大小」而不是一个孤零零的 token）。
//     这一组才接近实际使用，也才可能失败。
//
// 只看 A 组会得出「召回 93%」这种自欺欺人的结论。B 组才算数。
const days = listDays({ memDir, digestDir });

const query = (pattern, expect) => {
  let hits = [];
  try {
    const r = searchAll({ memDir, pattern, maxHits: 10, digestDir });
    hits = (r && r.hits) || [];
  } catch { hits = []; }
  const rank = hits.findIndex((h) => h.id === expect.id);
  return rank < 0 ? 0 : rank + 1;
};

const resultsA = [];
const resultsB = [];
for (const { word, list } of picked) {
  const expect = list.slice().sort((a, b) => a.at - b.at)[0];

  // A 组：单词
  resultsA.push({ word, expect: expect.id, day: expect.day, rank: query(word, expect) });

  // B 组：从同一条消息里再取 1 个词，凑成 2 词查询。
  //
  // 这里改过两次，两次都是我的错：
  //   第一版取「消息里的前 2 个词」→ 抽出来全是二元切词碎片（「也打」「出什」），
  //     组合无语义，零命中 36.7% 是题目烂，不是检索烂。
  //   第二版把词数从 3 降到 2 —— searchAll 是 AND 匹配，词越多越苛刻，
  //     3 个词全中在同一条消息里的概率天然低，那不是召回问题。
  //
  // 现在取**该消息里全局频率最低**的那个词（有区分度），配成 2 词查询。
  const own = [...new Set(tokens(expect.text || ''))]
    .filter((t) => t.length >= 2 && t !== word)
    .map((t) => ({ t, f: (byWord.get(t) || []).length }))
    .filter((x) => x.f >= 2 && x.f <= 400)     // 太少是唯一串，太多没有区分度
    .sort((a, b) => a.f - b.f);                // 频率低优先
  if (!own.length) continue;
  const multi = [word, own[0].t].join(' ');
  resultsB.push({ word: multi, expect: expect.id, day: expect.day, rank: query(multi, expect) });
}

// ── 4. 统计 ───────────────────────────────────────────────────────────
const pct = (x) => (x * 100).toFixed(1) + '%';
const report = (name, results, note) => {
  const n = results.length;
  if (!n) return { zero: 0, n: 0 };
  const at = (k) => results.filter((r) => r.rank > 0 && r.rank <= k).length;
  const zero = results.filter((r) => r.rank === 0).length;
  const mrr = results.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / n;
  console.log(`  ── ${name} ──` + (note ? `\n    ${note}` : ''));
  console.log(`    Top-1     ${String(at(1)).padStart(4)} / ${n}   ${pct(at(1) / n)}`);
  console.log(`    Top-3     ${String(at(3)).padStart(4)} / ${n}   ${pct(at(3) / n)}`);
  console.log(`    Top-5     ${String(at(5)).padStart(4)} / ${n}   ${pct(at(5) / n)}`);
  console.log(`    MRR       ${mrr.toFixed(3)}`);
  console.log(`    零命中    ${String(zero).padStart(4)} / ${n}   ${pct(zero / n)}`);
  console.log('');
  return { zero, n };
};

console.log('');
console.log(`  语料 ${entries.length} 条 / ${days.length} 天　罕见词池 ${rare.length} 个`);
console.log('');
const a = report('A 组 · 单词', resultsA, '虚高的一档：罕见词搜它自己，接近唯一串匹配');
const b = report('B 组 · 两词组合', resultsB, '这一组才算数：两个有区分度的词，接近真实提问');
const results = resultsA.concat(resultsB);

// 失败的挑几条出来看，不然只有数字没有抓手
const misses = results.filter((r) => r.rank === 0).slice(0, 8);
if (misses.length) {
  console.log('  ── 零命中的样本（排前 8 条）──');
  for (const m of misses) {
    console.log(`    「${m.word}」 期望 ${m.expect}（${m.day}）`);
  }
  console.log('');
}

const bad = results.filter((r) => r.rank > 5).slice(0, 5);
if (bad.length) {
  console.log('  ── 排到 5 名以外的（前 5 条）──');
  for (const b of bad) {
    console.log(`    「${b.word}」 期望 ${b.expect}（${b.day}）排第 ${b.rank}`);
  }
  console.log('');
}

// 退出码：零命中超过 10% 就算不合格，让 CI 能拦住
const failRate = b.n ? b.zero / b.n : 0;
if (failRate > 0.10) {
  console.log(`  ✗ B 组零命中 ${pct(failRate)} > 10%，召回不合格`);
  process.exit(1);
}
console.log(`  ✓ B 组零命中 ${pct(failRate)}，在 10% 以内`);
