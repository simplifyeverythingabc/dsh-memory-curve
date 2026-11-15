/**
 * 访问计数、提取时间序列与状态机
 *
 * 为什么要这个：
 *   现在的 L1-L5 是「算」出来的重要性，靠条数、跨度、密度猜。
 *   但真正的证据是「这条记忆有没有被真的用到」—— 查过一次就是一次投票。
 *   有了 access 计数，重要性公式里就能加一项实证权重，而不是纯靠结构猜。
 *
 * 0.4.0 起多记一样东西：**每次提取的时间戳**（`ts`）。
 *   只记「查过几次」「最后一次什么时候」不足以建模真实记忆 —— 人类的记忆强度
 *   取决于提取的**分布**而不只是次数：同样查 5 次，一天内连查 5 遍几乎不留痕，
 *   隔天各查一次却能记很久（spacing effect / desirable difficulty）。
 *   有了时间戳序列才能算间隔的离散度，进而给分散提取加分、给密集重复减分。
 *
 *   序列上限 `TS_KEEP`：真实实验里最近 5~10 次提取就足以拟合巩固曲线，
 *   再往前的时间戳对模型没有增量信息，只让 _access.json 无限膨胀。
 *   超出按 FIFO 丢弃最旧的。
 *
 * 状态：
 *   active   默认召回（近 14 天被查过，或本身留存高）
 *   cold     降权，默认不主动提，但可查
 *   archived 只留索引，原文仍在流水里
 *
 * 关键：**任何状态都不物理删除**。deleted 只有用户明确要求才发生，
 * 而且这个模块不负责删，只负责标记。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const COLD_AFTER_DAYS = 14;    // 超过这么久没被查过 -> cold
export const ARCHIVE_BELOW_R = 0.12;  // 留存低于这个且从未被查 -> archived
export const TS_KEEP = 24;            // 每个 id 保留的提取时间戳上限（FIFO）

/**
 * 提取诱发遗忘（retrieval-induced forgetting, 0.7.0）
 *
 * Anderson & Bjork 1994：**提取某条记忆会主动抑制与它竞争的那些**。
 * 反复想起「A 方案」会让「B 方案」越来越难想起 —— 不是因为它衰减了，而是被压住了。
 * 这是遗忘最反直觉的一层：记忆不是只增不减，想起一件事的代价是暂时想不起另一件。
 *
 * 插件这边对应的错：`touch()` 只给被查的加分，从不给相关条减分。结果是「查得越多，
 * 什么都越牢」——那是数据库，不是记忆。
 *
 * 实现上有意做得很轻：
 *   · 只抑制**与命中项共享实体**的竞争者（在 index.js 里挑，本模块只管记和算）
 *   · 强度上限 0.35，**只影响排序 rank，不改 level** —— 被压住的仍然看得到，只是排后面
 *   · 指数恢复，半衰期 6 小时：睡一觉就基本回来了
 *
 * 这条不写进「已修」清单的话很容易被误读成 bug（「我刚搜过这个，怎么那条掉下去了」）——
 * 它就是要这样。
 */
export const SUPPRESS_HALF_LIFE_H = 6;
export const SUPPRESS_MAX = 0.35;
export const SUPPRESS_DEFAULT = 0.12;

let cache = null;
let cacheFile = null;

function load(file) {
  if (cache && cacheFile === file) return cache;
  try {
    if (existsSync(file)) {
      cache = JSON.parse(readFileSync(file, 'utf8'));
      if (!cache || typeof cache !== 'object') cache = {};
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  cacheFile = file;
  return cache;
}

function flush(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 记一次访问：n 按权重累加、last 更新、时间戳入序列。
 *
 * `weight` 是 0.9.0 加的：**主动回忆与被动查看的巩固效果差很多**。
 * Roediger & Karpicke 2006 的 testing effect —— 真正把内容从记忆里**取出来**（读原文、
 * 复述），比只是**再看到一遍**（扫到摘要里的一行）强得多。前者是提取练习，后者近乎重读。
 *
 *   读原文（memory_curve_raw）    weight 1.5  ← 完整提取，最强巩固
 *   搜到摘要（memory_search）     weight 0.4  ← 只看到片段，弱提取
 *
 * n 因此可能不是整数，`retrieval = 1 + 0.18·ln(1+n)` 对浮点没有意见。
 * 老的整数记录原样兼容（累加即可）。
 */
export function touch(file, ids, query = '', weight = 1) {
  if (!ids || !ids.length) return { touched: 0 };
  const data = load(file);
  const now = new Date().toISOString();
  const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
  let touched = 0;
  for (const id of ids) {
    if (!id) continue;
    const rec = data[id] || { n: 0, last: null, first: now, ts: [] };
    // 先取旧 last 再覆盖 —— 0.5.4 之前这里写的是「rec.last !== now ? [rec.last] : []」，
    // 而上一行刚把 rec.last 赋成 now，那个比较恒假，于是老记录（0.3.x 只有 n/last/first、
    // 没有 ts）拿到空种子，只剩本次一个点，mergeTs 不足两点、spacingOf 一律返回 1 ——
    // 0.3.x 存量数据的间隔效应永久失效，而且不报错。
    const prevLast = rec.last;
    rec.n = (rec.n || 0) + w;
    rec.last = now;
    if (query) rec.q = String(query).slice(0, 60);
    if (!Array.isArray(rec.ts)) rec.ts = prevLast ? [prevLast] : [];
    rec.ts.push(now);
    if (rec.ts.length > TS_KEEP) rec.ts = rec.ts.slice(rec.ts.length - TS_KEEP);
    data[id] = rec;
    touched++;
  }
  flush(file, data);
  return { touched };
}

/** 取某 id 的访问记录 */
export function stats(file, id) {
  const data = load(file);
  return data[id] || { n: 0, last: null };
}

/**
 * 把一个事件的多个 id 的提取时间戳并成一条时间线。
 *
 * 为什么要按分钟去重：一次 `memory_curve_raw(event:...)` 会把该事件下**所有** id
 * 同时 touch，原始的 30 个时间戳其实是同一秒的 30 份拷贝。直接拿去做间隔统计会
 * 得到「间隔全是 0」的假象 —— 本来是分散提取，却被算成极度密集，spacing 反向扣分。
 * 所以同一分钟内的多次记录合并成一次提取。
 *
 * 老记录（0.3.x 只有 n/last/first，没有 ts）退化成单个点：拿不到分布就只当一次，
 * spacing 加成为 1，不奖不罚。
 */
function mergeTs(records) {
  const all = [];
  for (const rec of records) {
    if (!rec) continue;
    if (Array.isArray(rec.ts) && rec.ts.length) {
      for (const t of rec.ts) if (t) all.push(String(t));
    } else if (rec.last) {
      all.push(String(rec.last));
    }
  }
  if (!all.length) return [];
  all.sort();
  const out = [];
  let prevMin = null;
  for (const t of all) {
    const m = t.slice(0, 16);          // ISO 到分钟：2026-11-15T02:08
    if (m !== prevMin) { out.push(t); prevMin = m; }
  }
  return out;
}

/** 算某条记录此刻的残余抑制（指数恢复，半衰期 SUPPRESS_HALF_LIFE_H 小时） */
export function suppressionOf(rec, now = Date.now()) {
  if (!rec || !rec.sup || !rec.sup.at || !(rec.sup.amt > 0)) return 0;
  const h = Math.max((now - rec.sup.at) / 3600000, 0);
  return rec.sup.amt * Math.pow(0.5, h / SUPPRESS_HALF_LIFE_H);
}

/**
 * 记一次抑制：把 ids 这批记录的「被压制程度」抬到 amount。
 *
 * 用 max 而不是累加：连着查 10 次同一件事，不该把竞争者埋进地心 —— 真实的 RIF
 * 效应在几次重复后就饱和了。取 max 也让反复调用天然幂等。
 */
export function suppress(file, ids, amount = SUPPRESS_DEFAULT, now = Date.now()) {
  if (!ids || !ids.length) return { suppressed: 0 };
  const data = load(file);
  let n = 0;
  for (const id of ids) {
    if (!id) continue;
    const rec = data[id];
    if (!rec) continue;                       // 没有记录的 id 不凭空造一条抑制
    const cur = suppressionOf(rec, now);
    rec.sup = { at: now, amt: Math.min(SUPPRESS_MAX, Math.max(cur, amount)) };
    data[id] = rec;
    n++;
  }
  if (n) flush(file, data);
  return { suppressed: n };
}

/**
 * 算一个 id 集合的累计访问次数、最近提取时间、提取时间线与**当前残余抑制**。
 *
 * 抑制取 max 而不是求和：一个事件的多个 id 都被压制时，压制程度取决于最强的那条。
 */
export function sumAccess(file, ids, now = Date.now()) {
  const data = load(file);
  let n = 0;
  let last = null;
  let suppressAmt = 0;
  const recs = [];
  for (const id of ids || []) {
    const rec = data[id];
    if (!rec) continue;
    n += rec.n || 0;
    if (rec.last && (!last || rec.last > last)) last = rec.last;
    const s = suppressionOf(rec, now);
    if (s > suppressAmt) suppressAmt = s;
    recs.push(rec);
  }
  return { n, last, ts: mergeTs(recs), suppress: suppressAmt };
}

/** 判定状态 */
export function stateOf({ accessCount, lastAccess, R }, now = Date.now()) {
  if (accessCount > 0) {
    const ageDays = lastAccess ? (now - new Date(lastAccess).getTime()) / 86400000 : 999;
    return ageDays <= COLD_AFTER_DAYS ? 'active' : 'cold';
  }
  // 从没被查过：留存还行就 active，否则 archived（但原文仍在）
  return R >= ARCHIVE_BELOW_R ? 'active' : 'archived';
}

export const STATE_LABEL = { active: '热', cold: '冷', archived: '档' };

/** 全部访问数据（给报告用） */
export function dump(file) {
  return load(file);
}