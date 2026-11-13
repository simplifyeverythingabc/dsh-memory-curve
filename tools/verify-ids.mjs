// ID 悬空校验：摘要里引用的每个 memory_id 必须能在流水里找到。
//
// 为什么需要：ID 现在是从流水现算的，理论上不会悬空，但摘要一旦缓存或被人手改，
// 就可能引用到不存在的条目。悬空引用比没有引用更糟 —— 它会让人以为「查到了」。
//
// 只报警，不改数据。发现问题列出日期、缺失 ID、来源摘要文件。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
// 流水目录：与插件 src/index.js 的 memDir()、tools/memory-notes.mjs 保持同一套优先级。
// DSH_MEMORY_DIR 排第一 —— 三者必须一致，否则会对着空目录校验。
const MEM = process.env.DSH_MEMORY_DIR
  || process.env.MEMORY_GALAXY_DIR
  || 'D:\\memory';
const DIG = join(DSH_HOME, 'memory-notes', '_digest');

const HEAD = /^(?:\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}\s+［.+?］(?:\s*<!--\s*(m_[0-9]{8}_[0-9a-f]{6})\s*-->)?\s*$/;

// 1) 收集流水里真实存在的 ID
const live = new Set();
for (const fn of readdirSync(MEM)) {
  const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(fn);
  if (!m) continue;
  const day = m[1];
  const raw = readFileSync(join(MEM, fn), 'utf8');
  let seq = 0;
  for (const line of raw.split(/\r?\n/)) {
    const mm = HEAD.exec(line);
    if (!mm) continue;
    // 与 events.js readEntries 一致：兜底编号只给缺锚点的条目递增
    const anchored = mm[1];
    if (!anchored) seq += 1;
    live.add(anchored || `m_${day.replace(/-/g, '')}_${String(seq).padStart(6, '0')}`);
  }
}

// 2) 扫摘要里引用的 ID
//
// 哈希 id 之后，摘要里的范围行写的是「覆盖: m_xxx +27（不连续）」——
// 意思是「这条 + 后面还有 27 条不连续的兄弟」，总数 1+27。
// 旧的 /id:\s*m_\d{8}_\d{6}\.\./ 要求十进制序号 + id: 前缀，匹配不到任何一行，
// rangeBad 恒为空，输出「全部一致」是假绿灯。
//
// 哈希不能算术展开，所以只核对两件事：
//   a) 首尾 id 在流水里真实存在
//   b) 首尾之间的条数与事件头声明的条数一致
const dangling = [];
const used = new Set();
let digests = 0;
const rangeBad = [];

// 「覆盖: m_a +N（不连续）」或旧的「覆盖: m_a..m_b」
const COVER_RE = /覆盖:\s*(m_\d{8}_[0-9a-f]{6})(?:\s*\+(\d+))?(?:\.\.(m_\d{8}_[0-9a-f]{6}))?/g;
const HEADCNT_RE = /##\s*[^\n]*?（(\d+)条/;

for (const fn of readdirSync(DIG)) {
  if (!fn.endsWith('.md')) continue;
  digests += 1;
  const raw = readFileSync(join(DIG, fn), 'utf8');

  for (const m of raw.matchAll(COVER_RE)) {
    const first = m[1];
    const plusN = m[2] === undefined ? 0 : Number(m[2]);
    const last = m[3] || null;

    // a) 端点存在性
    used.add(first);
    if (!live.has(first)) dangling.push({ file: fn, id: first });
    if (last) {
      used.add(last);
      if (!live.has(last)) dangling.push({ file: fn, id: last });
    }

    // b) 条数核对：+N 表示「首条之外还有 N 条」，所以总数是 N+1
    const declared = plusN + 1;
    const at = m.index ?? 0;
    const ctxStart = raw.lastIndexOf('\n## ', at);
    if (ctxStart >= 0) {
      const seg = raw.slice(ctxStart, at);
      const hm = HEADCNT_RE.exec(seg);
      if (hm && Number(hm[1]) !== declared) {
        rangeBad.push({ file: fn, id: first, declared, claimed: Number(hm[1]) });
      }
    }
  }

  // 范围行之外散落的单条
  const withoutRanges = raw.replace(COVER_RE, ' ');
  for (const id of withoutRanges.match(/m_[0-9]{8}_[0-9a-f]{6}/g) || []) {
    used.add(id);
    if (!live.has(id)) dangling.push({ file: fn, id });
  }
}

// 3) 报告
console.log(`流水 ID ${live.size} 个　摘要 ${digests} 份　被引用 ${used.size} 个`);
if (!dangling.length) {
  console.log('悬空引用：0 —— 全部可回查');
} else {
  console.log(`悬空引用：${dangling.length} 处`);
  const byFile = new Map();
  for (const d of dangling) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(d.id);
  }
  for (const [f, ids] of byFile) {
    console.log(`  ${f}: ${ids.slice(0, 6).join(', ')}${ids.length > 6 ? ` …共 ${ids.length}` : ''}`);
  }
}

if (rangeBad.length) {
  console.log(`范围条数不符：${rangeBad.length} 处`);
  for (const r of rangeBad.slice(0, 8)) {
    console.log(`  ${r.file} ${r.id} 覆盖行算 ${r.declared} 条，事件头写 ${r.claimed} 条`);
  }
} else {
  console.log('范围条数核对：全部一致');
}

// 4) 数据完整性三查
const integrity = [];
const dayFiles = readdirSync(MEM).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
const sizes = new Map();
for (const fn of dayFiles) {
  const raw = readFileSync(join(MEM, fn), 'utf8');
  const day = fn.replace('.md', '');
  sizes.set(day, raw.length);
  const b = (raw.match(/dsh-note:auto-begin:7f3a/g) || []).length;
  const e = (raw.match(/dsh-note:auto-end:7f3a/g) || []).length;
  const heads = raw.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+［.+?］\s*<!--\s*m_[0-9]{8}_[0-9a-f]{6}\s*-->/gm) || [];
  const uniqHeads = new Set(heads).size;
  if (b !== e) integrity.push(`${fn} 标记不配对：BEGIN ${b} / END ${e}`);
  if (b > 1) integrity.push(`${fn} AUTO 区重复：BEGIN 出现 ${b} 次（应为 1）`);
  const dupRate = heads.length ? (heads.length - uniqHeads) / heads.length : 0;
  if (dupRate > 0.05) integrity.push(`${fn} 锚点重复率 ${(dupRate * 100).toFixed(0)}%（${heads.length} 个锚点只有 ${uniqHeads} 个唯一）`);
}
const days = [...sizes.keys()].sort();
for (let i = 7; i < days.length; i++) {
  const prev7 = days.slice(i - 7, i).map((d) => sizes.get(d));
  const avg = prev7.reduce((a, b) => a + b, 0) / prev7.length;
  const cur = sizes.get(days[i]);
  if (avg > 0 && cur > avg * 8) {
    integrity.push(`${days[i]}.md ${(cur / 1024).toFixed(0)}KB，是前 7 天均值 ${(avg / 1024).toFixed(0)}KB 的 ${(cur / avg).toFixed(1)} 倍（>8 倍，疑似膨胀）`);
  }
}

if (integrity.length) {
  console.log(`数据完整性：${integrity.length} 项异常`);
  for (const s of integrity) console.log(`  ! ${s}`);
} else {
  console.log(`数据完整性：${dayFiles.length} 天全部正常（标记配对 / 锚点唯一 / 体积无异常膨胀）`);
}

// 5) 反向统计
const uncovered = [...live].filter((id) => !used.has(id)).length;
console.log(`流水未进摘要的条目：${uncovered} / ${live.size}`);

// 悬空引用或条数不符都算失败 —— 之前只算 dangling，rangeBad 坏了也返回 0
process.exitCode = (dangling.length || rangeBad.length || integrity.length) ? 1 : 0;
