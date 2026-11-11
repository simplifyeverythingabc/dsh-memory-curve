/**
 * 访问计数与状态机
 *
 * 为什么要这个：
 *   现在的 L1-L5 是「算」出来的重要性，靠条数、跨度、密度猜。
 *   但真正的证据是「这条记忆有没有被真的用到」—— 查过一次就是一次投票。
 *   有了 access 计数，重要性公式里就能加一项实证权重，而不是纯靠结构猜。
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

/** 记一次访问：n 自增、last 更新 */
export function touch(file, ids, query = '') {
  if (!ids || !ids.length) return { touched: 0 };
  const data = load(file);
  const now = new Date().toISOString();
  let touched = 0;
  for (const id of ids) {
    if (!id) continue;
    const rec = data[id] || { n: 0, last: null, first: now };
    rec.n += 1;
    rec.last = now;
    if (query) rec.q = String(query).slice(0, 60);
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

/** 算一个 id 集合的累计访问次数 */
export function sumAccess(file, ids) {
  const data = load(file);
  let n = 0;
  let last = null;
  for (const id of ids || []) {
    const rec = data[id];
    if (!rec) continue;
    n += rec.n || 0;
    if (rec.last && (!last || rec.last > last)) last = rec.last;
  }
  return { n, last };
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