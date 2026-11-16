/**
 * 事件索引持久化（0.14.0）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * 0.13.x 每次启动（或缓存失效）都要把**全部语料**重新解析 + 聚类一遍。
 * 实测增长曲线（合成语料）：
 *
 *   条数     全量聚类   事件数
 *   1k        10 ms      36
 *   5k        24 ms     179
 *   20k       91 ms     715
 *   100k     438 ms    3572      ← 线性，百万条就是 4.4 秒
 *
 * 这就是「无限对话」的硬墙：语料每天在长，每次开新对话都要把整堵墙搬一遍。
 *
 * ── 人是怎么做的 ────────────────────────────────────────────────────
 *
 * 人不会每天早晨把一生重放一遍。旧记忆早就整理好放在那儿了，只有「新发生的那一段」
 * 需要在醒来后整理入档 —— 这正是睡眠巩固在做的事。
 *
 * ── 判据必须是**逐文件**的，不能是整体指纹 ──────────────────────────
 *
 * 这一点我第一版做错了：用整体指纹（所有文件的 size+mtime 拼一个串）判断，
 * 结果**对话里每加一条消息指纹就变，每次都全量重建** —— 优化完全失效。
 *
 * 而「加一条消息」恰恰是最常见的操作。所以判据必须是逐文件的：
 *
 *   · 没变的文件 → 直接复用它们贡献的事件
 *   · 只有**末尾连续几天**变了（正常情况就是「今天」）→ 前缀复用 + 只重算尾部
 *   · 中间某天变了（补录/改历史）或文件被删 → 全量重建
 *
 * ── 指纹内容变了但 size+mtime 没变的情况 ────────────────────────────
 *
 * 会被判为「没变」而读到旧事件。这是刻意的权衡：手工伪造 mtime 不是正常使用方式，
 * 为它每次跑全量（O(语料大小) 读盘）不值得，正好毁掉整个优化。
 *
 * ── 原子性 ──────────────────────────────────────────────────────────
 *
 * 同 `_threads.json` / `_vectors.json`：写临时文件再 rename。
 * 坏掉的索引不该拖垮插件 —— 读失败就当没有，全量重建一次而已。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const INDEX_VERSION = 2;

/**
 * 只存「从条目推出的、不随时间和访问变化」的字段。
 *
 * 刻意排除 `R`/`S`/`level`/`accessCount`/`suppress`/`confidence` —— 那些每次都按
 * `now` 与 `_access.json` 重算。存进来会让「旧索引 + 新时间」算出过期的衰减，
 * 那比慢更糟。
 */
const KEEP_FIELDS = [
  'day', 'startAt', 'lastAt', 'ids', 'count', 'span', 'startIdx', 'endIdx',
  'sigDensity', 'salience', 'openness', 'title', 'head',
  'serial', 'threadS',
];

// `toks` / `entities` 不在 KEEP_FIELDS 里，但**必须存** —— 它们是 Set，
// 上面的通用拷贝循环会原样带走一个 Set 引用，JSON 序列化后变成 `{}`。
// 0.14.0 的教训：漏了它们导致 seed 之后旧事件 token 集为空，
// `memory_search` 匹配不到旧事件（分级不受影响，所以不会显形）。
//
// `items` / `texts` 则**刻意不存**：它们可以从 `startIdx..endIdx` 精确重建，
// 而 texts 占索引 94% 的体积。存它等于把 md 内容复制一份，
// 再花 30 ms 解析；不存改读 md 只要 22 ms。

/** 逐文件 stat（不读内容），返回 `{ [文件名]: {size, mtimeMs} }` */
export function scanFiles(memDir) {
  const out = {};
  let names;
  try { names = readdirSync(memDir); } catch { return out; }
  for (const fn of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(fn)) continue;
    try {
      const st = statSync(join(memDir, fn));
      out[fn] = { size: st.size, mtimeMs: st.mtimeMs };
    } catch { /* 单个文件 stat 失败就跳过 */ }
  }
  return out;
}

/**
 * 判断索引能复用到哪：
 *
 * @returns {{ mode: 'full'|'tail'|'none', seedCount?: number, tailFromDay?: string }}
 *   'none' 索引完全可用（一个文件都没变）
 *   'tail' 只有末尾连续几天变了，可用 seed + 重算尾部
 *   'full' 必须全量重建
 */
export function planReuse(cached, current) {
  if (!cached || !current) return { mode: 'full' };
  const cachedNames = Object.keys(cached).sort();
  const currentNames = Object.keys(current).sort();
  if (!cachedNames.length || !currentNames.length) return { mode: 'full' };

  // 有文件被删 → 全量（事件可能横跨被删的那天，无法局部拆除）
  for (const n of cachedNames) if (!(n in current)) return { mode: 'full' };

  const changed = currentNames.filter((n) => {
    const a = cached[n];
    const b = current[n];
    return !a || a.size !== b.size || a.mtimeMs !== b.mtimeMs;
  });
  if (!changed.length) return { mode: 'none' };

  // 只有「比末次缓存文件还靠后」的文件变了，才算尾部变化
  const lastCached = cachedNames[cachedNames.length - 1];
  const firstChanged = changed[0];
  if (firstChanged < lastCached) return { mode: 'full' };

  return { mode: 'tail', tailFromDay: firstChanged.slice(0, 10) };
}

/** 读索引。返回 null 表示没有可用索引。 */
export function loadIndex(file) {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    if (!o || o._v !== INDEX_VERSION) return null;
    if (!Array.isArray(o.events) || !Number.isSafeInteger(o.entryCount)) return null;
    if (!o.files || typeof o.files !== 'object') return null;
    // 内容校验：每个事件都必须带 toks 数组。
    // 0.14.0/0.14.1 写出的索引没有它，读回来会让分级全塌 L5，
    // 而且**不会报错**。宁可全量重建一次，也不要拿一份算不对的索引。
    // （版本号已升到 2 把它们挡在门外，这里再兜一层，防止将来又漏字段。）
    if (!o.events.length) return null;
    for (const e of o.events) {
      if (!Array.isArray(e.toks)) return null;
    }

    const events = o.events.map((e) => {
      const ev = {};
      for (const k of KEEP_FIELDS) if (k in e) ev[k] = e[k];
      ev.toks = new Set(e.toks || []);
      ev.entities = new Set(e.entities || []);
      // items / texts **不存**，由调用方用 startIdx..endIdx 从 entries 重建。
      // 先给空数组占位，让依赖 `.length` 的代码不至于炸。
      ev.items = [];
      ev.texts = [];
      return ev;
    });
    return { files: o.files, events, entryCount: o.entryCount, built: o.built || 0 };
  } catch {
    return null;
  }
}

/** 写索引。返回 true 表示真的写下去了。 */
export function saveIndex(file, files, events, entryCount) {
  try {
    const slim = events.map((e) => {
      const o = {};
      for (const k of KEEP_FIELDS) {
        if (k in e) o[k] = e[k];
      }
      // Set 必须显式展开成数组 —— 通用拷贝会把 Set 引用原样带走，
      // JSON.stringify(Set) 是 `{}`，读回来就成了空集。
      o.toks = e.toks instanceof Set ? [...e.toks] : (e.toks || []);
      o.entities = e.entities instanceof Set ? [...e.entities] : (e.entities || []);
      return o;
    });
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({
      _v: INDEX_VERSION, built: Date.now(), files, entryCount, events: slim,
    }), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
