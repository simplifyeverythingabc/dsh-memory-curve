/**
 * 从 DSH 会话日志里抽出每天说过的话，写成 <OUT>/YYYY-MM-DD.md
 *
 * 为什么这么做：chatlog.md 是手写维护的，会断；会话日志是宿主自己落的，
 * 一直在长。按天生成 note 之后，记忆星系每次重新生成都能看到最新几天。
 *
 * 日志是「多帧 zstd」：每帧一段 JSONL。整段流式解压只能拿到第一帧（会话头），
 * 所以这里按魔数 28 B5 2F FD 切帧，逐帧解压再拼起来。
 *
 * ── 2026-11-10 修 ────────────────────────────────────────────────
 * 1) 以前整文件 writeFileSync，会连手写内容一起冲掉。现在用 AUTO-BEGIN /
 *    AUTO-END 标记把自动区单独圈出来，只替换标记之间的部分，标记外原样保留。
 * 2) 首次遇到没有标记的旧文件：先备份成 .bak-<时间戳>，再改写成带标记的格式，
 *    避免手写内容被无声吞掉。
 * 3) 解压失败的帧以前是 catch {} 静默跳过，现在计数并在结尾报告。
 * 4) 单天超 MAX_CHARS_PER_DAY 被 break 截断时，在文件里留一行说明，不再无声丢内容。
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';

// 会话日志目录：DSH_HOME/sessions
const DSH_HOME = process.env.DSH_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const SESSIONS = path.join(DSH_HOME, 'sessions');

// 流水输出目录 —— 与插件 src/index.js 的 memDir() 必须是同一个值，否则生成的内容
// 插件读不到（早期版本踩过：这里写 memory-notes、插件读 D:\memory，中间靠手写 ps1
// 同步，别人装完根本用不了）。
//
// 唯一真相在 src/paths.js 的 resolveMemDir()。tools 可能脱离插件包部署，
// 所以就地在两种目录形态里找 src/。
//
// D:\memory 的「可写性」不在这里判断 —— 由下面的 assertWritable() 显式报错，
// 不做静默改写到别处，那正是「写一个读另一个」的来源。
const SRC_BASES = ['../src/', '../profiles/desktop/node_modules/dsh-memory-curve/src/'];

async function loadSrc(name) {
  const errs = [];
  for (const base of SRC_BASES) {
    try { return await import(base + name); }
    catch (e) { errs.push(`  ${base}${name} → ${e.message}`); }
  }
  console.error(`找不到 src/${name}：`);
  for (const s of errs) console.error(s);
  process.exit(1);
}

const { resolveMemDir } = await loadSrc('paths.js');

const OUT = resolveMemDir();

// 提前探测可写性，别等跑到一半才 EPERM
function assertWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    console.error(`流水目录不可写：${dir}`);
    console.error(`  ${err.code}: ${err.message}`);
    console.error('');
    console.error('换一个可写的位置再跑，例如：');
    console.error('  DSH_MEMORY_DIR=<可写目录> node tools/memory-notes.mjs');
    process.exit(1);
  }
}

assertWritable(OUT);

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// 完整记忆优先：不设实质上限（星系单文件上限是 6MB，远没到）。
// 保留一个极高阈值只作保险，避免异常日志把内存撑爆。
const MAX_CHARS_PER_DAY = 5000000;
// 标记带一个固定但不常见的哨兵，避免正文里提到这两个词就把文件切坏
const BEGIN = '<!-- dsh-note:auto-begin:7f3a -->';
const END = '<!-- dsh-note:auto-end:7f3a -->';

let frameFail = 0;
let frameOk = 0;

function decompressFrames(buf) {
  const parts = [];
  let start = 0;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      if (i > start) {
        try { parts.push(zlib.zstdDecompressSync(buf.subarray(start, i))); frameOk++; }
        catch { frameFail++; }
      }
      start = i;
    }
  }
  if (start < buf.length) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(start))); frameOk++; }
    catch { frameFail++; }
  }
  return Buffer.concat(parts).toString('utf8');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

const byDay = new Map();   // '2026-11-04' -> [{t, role, text}]

function collect(dir) {
  if (!fs.existsSync(dir)) {
    console.warn(`会话日志目录不存在：${dir}`);
    console.warn('  DSH 至少跑过一次对话之后，这里才会有 .zstd 文件。');
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { collect(full); continue; }
    if (!entry.name.endsWith('.zstd')) continue;

    let raw;
    try { raw = decompressFrames(fs.readFileSync(full)); } catch { continue; }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const msg = ev?.data?.message;
      if (!msg) continue;
      const role = msg.role;
      if (role !== 'user' && role !== 'assistant') continue;
      if (msg.source?.kind === 'system-prompt') continue;
      // 跳过工具结果、命令回显，只留人话
      if (role === 'user' && msg.content?.some?.((b) => b?.type === 'tool-result')) continue;

      let text = textOf(msg.content);
      if (!text || text.length < 2) continue;
      if (text.startsWith('[tool_result]')) continue;
      // 思考过程不是话，别写进日记
      text = text
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/<content>[\s\S]*?<\/content>/gi, '')
        .replace(/[\s\S]*?<\/think(?:ing|pad)?>/gi, '')
        .trim();
      if (!text || text.length < 2) continue;
      // 整段没有中文、又很长，基本是内部推理
      if (text.length > 200 && !/[\u4e00-\u9fa5]/.test(text)) continue;

      const ts = Number(ev.time ?? msg.time ?? 0);
      if (!ts) continue;
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({ t: ts, hhmm, role, text });
    }
  }
}

collect(SESSIONS);
fs.mkdirSync(OUT, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
let wrote = 0;
let keptManual = 0;

for (const [day, items] of [...byDay].sort()) {
  items.sort((a, b) => a.t - b.t);

  // 同一天里重复的话只留第一次（压缩后重放的上下文会出现重复）
  const seen = new Set();
  const lines = [day, ''];
  let chars = 0;
  let truncated = false;
  const dayCompact = day.replace(/-/g, '');
  for (const it of items) {
    // 去重 key 必须是全文哈希，不能只看开头 120 字。
    // 前 120 字的规则会误删「开头相同、后面不同」的消息 —— 实测把 1245 条
    // 砍到 490 条，11-09 从 161 掉到 9，等于把大半流水丢了。
    // 全文哈希只删真正一模一样的（compaction 重放那段），不同内容全保留。
    const sig = createHash('sha1').update(it.role + '\u0000' + it.text).digest('hex');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const who = it.role === 'user' ? '主人' : '小鱼';
    // 稳定锚点：摘要靠它精确指回原文，检索也能按 id 直取单条。
    // id 用内容哈希，不用顺序号。
    //
    // 顺序号的问题：脚本每次全量重建，session 日志一长，后面的编号全部漂移 ——
    // 同一条内容今天叫 m_...228，明天叫 m_...189。而 access.json 记的是 id 级计数、
    // ids.json 的事件数组引用的也是 id、回答里引用的 [m_xxx] 还是 id，
    // 全都指向了错内容。顺序编号和「写入时分配、之后不变」这个原则根本冲突。
    //
    // 内容哈希：同一段文字永远得到同一个 id，新数据只新增、不重排。
    const id = `m_${dayCompact}_${createHash('sha1').update(it.text).digest('hex').slice(0, 6)}`;
    // 正文里不能出现标记行 —— 有些消息本身就在讨论这套标记（贴代码、贴报错），
    // 原样写进文件会被下次运行的剥除逻辑误吞，也会让 BEGIN/END 计数失衡。
    // 实测：文件里 14 个 BEGIN / 8 个 END，全是因为正文带了标记。
    const safeText = it.text
      .split(/\r?\n/)
      .filter((ln) => !ln.includes('dsh-note:auto-begin') && !ln.includes('dsh-note:auto-end'))
      .join('\n');
    const block = `${day} ${it.hhmm} ［${who}］ <!-- ${id} -->\n${safeText}\n`;
    if (chars + block.length > MAX_CHARS_PER_DAY) { truncated = true; break; }
    chars += block.length;
    lines.push(block);
  }
  if (lines.length <= 2) continue;
  if (truncated) {
    lines.push(`（本日内容超过 ${MAX_CHARS_PER_DAY} 字符，后面还有 ${items.length - seen.size} 条没写进来）\n`);
  }

  const file = path.join(OUT, `${day}.md`);
  let manual = '';

  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    // 把所有 AUTO 区整体剥掉，剩下的才算手写。
    // 以前用 indexOf/lastIndexOf 取首尾，结果两次运行留下的重复 AUTO 区
    // 会被当成手写内容保留下来，越滚越多。
    // 按行扫描剥除，不用配对正则。
    // 配对正则的问题：一旦 BEGIN/END 数量不平衡（历史上累积出来的），
    // 它只能匹配成对的那几段，孤立 BEGIN 后面的全部内容会被当「手写」保留，
    // 下次再叠加一遍 —— 这就是文件从 700KB 涨到 2.8MB 的机制。
    // 逐行状态机：见到 BEGIN 进丢弃态，见到 END 退出，到文件尾仍在丢弃态就丢掉剩余全部。
    const stripped = (() => {
      const out = [];
      let skipping = false;
      for (const line of old.split(/\r?\n/)) {
        if (line.includes('dsh-note:auto-begin:7f3a')) { skipping = true; continue; }
        if (line.includes('dsh-note:auto-end:7f3a')) { skipping = false; continue; }
        if (!skipping) out.push(line);
      }
      return out.join('\n');
    })();
    if (stripped !== old) {
      manual = stripped.replace(/\n{3,}/g, '\n\n').trim();
      if (manual) keptManual++;
    } else {
      // 老文件没有标记 —— 先备份再接管
      const bak = `${file}.bak-${stamp}`;
      fs.copyFileSync(file, bak);
      manual = '';
      console.log(`  ${day}: 旧格式无标记，已备份到 ${path.basename(bak)}`);
    }
  }

  const body = [BEGIN, lines.join('\n').trimEnd(), END].join('\n');
  const content = manual ? `${manual}\n\n${body}\n` : `${body}\n`;
  fs.writeFileSync(file, content, 'utf8');
  wrote++;
}

console.log(`写入 ${wrote} 天：${[...byDay.keys()].sort().join(', ')}`);
if (keptManual) console.log(`保留了 ${keptManual} 个文件里的手写内容`);
if (frameFail) console.log(`⚠ ${frameFail} 个 zstd 帧解压失败被跳过（成功 ${frameOk} 帧）`);
