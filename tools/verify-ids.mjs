// ID 悬空校验：摘要里引用的每个 memory_id 必须能在流水里找到。
//
// 为什么需要：ID 现在是从流水现算的，理论上不会悬空，但摘要一旦缓存或被人手改，
// 就可能引用到不存在的条目。悬空引用比没有引用更糟 —— 它会让人以为「查到了」。
//
// 只报警，不改数据。发现问题列出日期、缺失 ID、来源摘要文件。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const MEM = process.env.MEMORY_GALAXY_DIR || 'D:\\memory';
const DIG = join(DSH_HOME, 'memory-notes', '_digest');

const HEAD = /^(?:\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}\s+［.+?］(?:\s*<!--\s*(m_[0-9]{8}_[0-9a-f]{6})\s*-->)?\s*$/;
const ID_RE = /m_[0-9]{8}_[0-9a-f]{6}/g;

// 1) 收集流水里真实存在的 ID
const live = new Set();
let seqGaps = 0;
for (const fn of readdirSync(MEM)) {
  const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(fn);
  if (!m) continue;
  const day = m[1];
  const raw = readFileSync(join(MEM, fn), 'utf8');
  let seq = 0;
  for (const line of raw.split(/\r?\n/)) {
    const mm = HEAD.exec(line);
    if (!mm) continue;
    seq += 1;
    // 旧格式没有锚点时按位置补，与 events.js / digest.js 的兜底规则一致
    live.add(mm[1] || `m_${day.replace(/-/g, '')}_${String(seq).padStart(6, '0')}`);
  }
}

// 2) 扫摘要里引用的 ID —— 范围行要展开，否则一句「m_a..m_b」只算两个 ID，
//    「NNNN 条未进摘要」那种统计全是假的。
const dangling = [];
const used = new Set();
let digests = 0;
let rangeBad = [];   // 条数对不上的范围

// 只认真正的连续范围；带「不连续」标注的行单独统计，不当成范围
const RANGE_RE = /id:\s*m_(\d{8})_(\d{6})\.\.m_\d{8}_([0-9a-f]{6})(?!（不连续）)/g;
const HEADCNT_RE = /##\s*[^\n]*?（(\d+)条/;

for (const fn of readdirSync(DIG)) {
  if (!fn.endsWith('.md')) continue;
  digests += 1;
  const raw = readFileSync(join(DIG, fn), 'utf8');

  // 2a) 范围展开 + 条数核对
  for (const m of raw.matchAll(RANGE_RE)) {
    const day = m[1];
    const from = +m[2], to = +m[3];
    const declared = to - from + 1;
    for (let n = from; n <= to && n - from < 2000; n++) {
      const id = `m_${day}_${String(n).padStart(6, '0')}`;
      used.add(id);
      if (!live.has(id)) dangling.push({ file: fn, id });
    }
    // 同一事件头的条数声明（## 12:55–13:11（28条 · L1））
    const at = raw.indexOf(m[0]);
    const ctxStart = raw.lastIndexOf('\n## ', at);
    if (ctxStart >= 0) {
      const seg = raw.slice(ctxStart, at);
      const hm = HEADCNT_RE.exec(seg);
      if (hm && +hm[1] !== declared) {
        rangeBad.push({ file: fn, id: `m_${day}_${m[2]}..${m[3]}`, declared, claimed: +hm[1] });
      }
    }
  }

  // 2b) 范围之外散落的单条
  const withoutRanges = raw.replace(RANGE_RE, ' ');
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
    console.log(`  ${r.file} ${r.id} 范围算 ${r.declared} 条，事件头写 ${r.claimed} 条`);
  }
} else {
  console.log('范围条数核对：全部一致');
}

// ── 3) 数据完整性三查（这次膨胀是靠手动发现的，不该有第二次）
const integrity = [];
const dayFiles = readdirSync(MEM).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
const sizes = new Map();
for (const fn of dayFiles) {
  const raw = readFileSync(join(MEM, fn), 'utf8');
  const day = fn.replace('.md', '');
  sizes.set(day, raw.length);
  const b = (raw.match(/dsh-note:auto-begin:7f3a/g) || []).length;
  const e = (raw.match(/dsh-note:auto-end:7f3a/g) || []).length;
  const allIds = raw.match(/m_[0-9]{8}_[0-9a-f]{6}/g) || [];
  // 只数块头锚点（行首日期时间说话人后面那个），正文里引用的 id 不算重复。
  // 否则「讨论记忆系统的对话」会被误判成数据损坏 —— 那正是 10-25/10-26 报的假警。
  const heads = raw.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+［.+?］\s*<!--\s*m_[0-9]{8}_[0-9a-f]{6}\s*-->/gm) || [];
  const uniqHeads = new Set(heads).size;
  // A. 标记配对
  if (b !== e) integrity.push(`${fn} 标记不配对：BEGIN ${b} / END ${e}`);
  if (b > 1) integrity.push(`${fn} AUTO 区重复：BEGIN 出现 ${b} 次（应为 1）`);
  // B. 块头锚点唯一率
  const dupRate = heads.length ? (heads.length - uniqHeads) / heads.length : 0;
  if (dupRate > 0.05) integrity.push(`${fn} 锚点重复率 ${(dupRate * 100).toFixed(0)}%（${heads.length} 个锚点只有 ${uniqHeads} 个唯一）`);
}
// C. 文件大小日环比
const days = [...sizes.keys()].sort();
for (let i = 7; i < days.length; i++) {
  const prev7 = days.slice(i - 7, i).map((d) => sizes.get(d));
  const avg = prev7.reduce((a, b) => a + b, 0) / prev7.length;
  const cur = sizes.get(days[i]);
  // 阈值放到 8 倍：对话量本来就波动大（11-08 有 99KB、11-04 有 69KB 都是正常的），
  // 真正的膨胀是几十倍量级（2.8MB vs 700KB）。太敏感只会天天误报，久了就没人看。
  if (avg > 0 && cur > avg * 8) {
    integrity.push(`${days[i]}.md ${(cur/1024).toFixed(0)}KB，是前 7 天均值 ${(avg/1024).toFixed(0)}KB 的 ${(cur/avg).toFixed(1)} 倍（>8 倍，疑似膨胀）`);
  }
}

if (integrity.length) {
  console.log(`数据完整性：${integrity.length} 项异常`);
  for (const s of integrity) console.log(`  ! ${s}`);
} else {
  console.log(`数据完整性：${dayFiles.length} 天全部正常（标记配对 / 锚点唯一 / 体积无异常膨胀）`);
}

// 4) 反向统计：有多少流水条目从未被摘要引用（不是错误，但说明摘要覆盖不全）
const uncovered = [...live].filter((id) => !used.has(id)).length;
console.log(`流水未进摘要的条目：${uncovered} / ${live.size}`);

process.exitCode = dangling.length ? 1 : 0;