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
import { join, dirname } from 'node:path';

export const COLD_AFTER_DAYS = 14;    // 超过这么久没被查过 -> cold
export const ARCHIVE_BELOW_R = 0.12;  // 留存低于这个且从未被查 -> archived
export const TS_KEEP = 24;            // 每个 id 保留的提取时间戳上限（FIFO）

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

/** 记一次访问：n 自增、last 更新、时间戳入序列 */
export function touch(file, ids, query = '') {
  if (!ids || !ids.length) return { touched: 0 };
  const data = load(file);
  const now = new Date().toISOString();
  let touched = 0;
  for (const id of ids) {
    if (!id) continue;
    const rec = data[id] || { n: 0, last: null, first: now, ts: [] };
    rec.n += 1;
    rec.last = now;
    if (query) rec.q = String(query).slice(0, 60);
    // 时间戳序列：老记录可能没有 ts，补成只含 last 的起点，再追加本次
    if (!Array.isArray(rec.ts)) rec.ts = rec.last && rec.last !== now ? [rec.last] : [];
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

/** 算一个 id 集合的累计访问次数、最近提取时间与提取时间线 */
export function sumAccess(file, ids) {
  const data = load(file);
  let n = 0;
  let last = null;
  const recs = [];
  for (const id of ids || []) {
    const rec = data[id];
    if (!rec) continue;
    n += rec.n || 0;
    if (rec.last && (!last || rec.last > last)) last = rec.last;
    recs.push(rec);
  }
  return { n, last, ts: mergeTs(recs) };
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