/**
 * 事件识别 + 遗忘曲线分级
 *
 * 为什么按事件而不是按词：
 *   按词统计会选出「文件」「直接」「一次」这种到处都有的虚词，没有信息量；
 *   而「03-13 排查连接池超时」本身是一个有始有终的事件，强度体现在跨度、
 *   密度和最后提及时间上，这些恰恰是遗忘曲线的作用对象。
 *
 * 算法：
 *   1. 读 <记忆目录>/YYYY-MM-DD.md，切成条目（日期 + 时间 + 说话人）
 *   2. 相邻条目：间隔 ≤ GAP_MIN，或 ≤180 分钟且词集 Jaccard ≥ 0.18 → 归入同一事件
 *   3. 强度 S = 结构项 × retrieval × spacing × salience × zeigarnik
 *      具体系数见 gradeEvents() 里那一行乘法，这里不复制
 *   4. 留存 R = (1 + POWER_K·x)^(-POWER_BETA)，x = 距今小时 ÷ (S×24)
 *      —— 幂律，不是指数；长尾明显更厚，很久以前的事不会瞬间归零
 *   5. 两条闸：绝对阈值 → 相对配额（L1≤10%、L2≤22%、L3≤25%），见 gradeEvents()
 *
 * 注入只给 L1+L2（+部分 L3）的梗概，完整内容永远留在记忆目录里。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const GAP_MIN = 18;        // 相邻条目间隔超过这么多分钟就断事件
export const MAX_EVENT_ITEMS = 28; // 单个事件最多这么多条，超了就强制切（否则连聊几小时会并成一坨）
export const STOP = new Set(`今天 明天 昨天 现在 已经 可以 这个 那个 什么 怎么 因为 所以 但是 如果
然后 时候 东西 问题 一下 一个 不是 就是 还是 这样 那样 我们 你们 他们 自己 没有 知道 觉得
应该 需要 这里 那里 好的 嗯嗯 可能 其实 之前 之后 主人 小鱼 摘要 一条 这条 两条 说明 结果
内容 文件 直接 一次 里的 运行 脚本 验证 重新 好了 不会 真正 两个 出来 确认 或者 关键 加载
模型 使用 处理 完成 全部 部分 一样 有点 有些 这些 那些 地方 方式 情况 方法 事情`.split(/\s+/));

const HAN = /[\u4e00-\u9fff]+/g;
const WORD = /[a-z0-9_]{3,}/g;

export function tokens(s) {
  // 先剔掉 memory_id 和注释标记：m_20261109_000001 会被二元/整词切成
  // 「m」「20261109」「000001」，占满 topic 名额，把真术语挤出去（实测过）。
  const low = String(s)
    .toLowerCase()
    .replace(/m_\d{8}_[0-9a-f]{6}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/dsh-note:[a-z0-9:-]+/g, ' ');
  const out = new Set();
  for (const seg of low.match(HAN) || []) {
    if (seg.length === 1) { out.add(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  for (const w of low.match(WORD) || []) out.add(w);
  return out;
}

const PAD2 = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${PAD2(d.getMonth() + 1)}-${PAD2(d.getDate())}`; };

function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

/** 英文通用词：做主题词毫无意义，只会把真关键词挤下去 */
export const EN_STOP = new Set(('count unit return complete initial earlier value type index string '
+ 'error data name text line file test code true false null void async await const let var '
+ 'function class object array new delete this that with from into over under more less '
+ 'first last next prev before after start end open close read write load save send recv '
+ 'also just only even much many some any all both non run runs ran set sets get gets put puts '
+ 'use used using make made take took give gave here there where when what which while '
+ 'because should could would must need want know think see look find found call called '
+ 'back away down come came still again okay yes')
.split(/\s+/).filter(Boolean));

/** 标签行 / 纯标记行，不进摘要 */
const JUNK = /^<\/?[a-z][a-z-]*>?$|^<\/?[a-z][a-z-]*\b[^>]*>\s*$/i;

/**
 * 情绪显著性信号（0.4.0）
 *
 * 真实记忆不是按「说了多少字」存留的 —— 带情绪的事件记得最牢。杏仁核在编码阶段
 * 给高唤醒事件盖一个「优先保存」的章，这就是为什么人记得住吵架、事故、被否定的
 * 那一刻，却记不住上周三午饭吃了什么。
 *
 * 这里用可计算的代理信号，不调用模型：
 *   纠错/否定 —— 「不对」「搞错了」：说明这条路上撞过墙，撞墙的事最难忘
 *   故障/报错 —— 失败体验的记忆强度显著高于顺利体验
 *   返工/反复 —— 投入的返工次数是沉没成本，也是情绪投入
 *   强调/命令 —— 「必须」「别」是高唤醒指令
 *   决策/结论 —— 拍板的那一刻是情景记忆的锚点
 *   达成/解决 —— 成功闭合同样巩固（Zeigarnik 的完成侧）
 *   连续感叹 —— 纯唤醒度信号
 *
 * 权重按「这段记忆被回想起来的概率」排序，不是按出现频率。
 */
const SIGNAL = [
  { re: /不对|错了|搞错|理解错|不是这样|弄反/g, w: 1.0 },
  // 正则里「报错」原来写了两遍。不影响行为（alternation 在同一位置只命中一个分支，
// lastIndex 前移，同一处文字不会被计两次），但留着会让读的人以为有加倍效果。
  { re: /失败|报错|崩|挂掉|死机|超时|无响应|异常|exception|error|failed|crash|broken/gi, w: 1.0 },
  { re: /重来|反复|返工|折腾|再来一次|又改|又出/g, w: 0.8 },
  { re: /必须|一定|千万|别忘了|关键|重点|注意|小心|立刻|马上|赶紧/g, w: 0.8 },
  { re: /决定|最终|确定|敲定|就这个|结论|定了/g, w: 0.9 },
  { re: /修好|搞定|跑通|解决|通过|上线|成了|能用了/g, w: 0.7 },
  { re: /[！!]{2,}/g, w: 0.5 },
];

/**
 * 给一个事件算原始情绪信号密度（未归一）。
 *
 * 只依赖事件文本，不依赖 now。归一化必须放在「全部事件」层面做 —— 见
 * salienceAll()：技术对话里「通过」「解决」「确定」几乎每条消息都有，
 * 用绝对密度当显著性等于给所有事件加同一个常数，毫无区分度（实测 151 个事件里
 * 120 个顶到上限）。真实记忆的显著性也是相对的：跟同期的其它经历比，
 * 这一段是否更「有事发生」。
 */
export function signalDensity(ev) {
  const txt = (ev.texts || []).join('\n');
  if (!txt) return 0;
  let score = 0;
  for (const { re, w } of SIGNAL) {
    const m = txt.match(re);
    // 单个信号最多计 4 次：连续出现 20 个「报错」不代表比 4 个更难忘，
    // 那只是同一件事被重复贴了一遍。
    if (m) score += w * Math.min(m.length, 4);
  }
  return score / Math.max((ev.items || []).length, 1);   // 每条消息的平均信号强度
}

/**
 * 把全部事件的原始信号密度归一成显著性乘数（1.0 ~ 1.35）。
 *
 * 用分位数而不是绝对值：中位数及以下一律 1.0（没人会因为「今天也干活了」而被
 * 额外加固），中位数到 p90 线性升到 1.15，p90 以上再升到 1.35 封顶。
 * 这样显著性永远只奖给**同一段人生里最突出的那批**，与用词风格无关。
 */
export function salienceAll(events) {
  if (!events.length) return;
  // 原始密度按事件缓存（sigDensity）：增量聚类时只有被延长的那一个需要重算，
  // 其余直接复用。分位归一本身必须每次全量做（总数变了分位就变），但那只依赖
  // 已算好的标量，是一遍 O(n) 取分位，不再扫文本。
  const raw = events.map((ev) => {
    if (ev.sigDensity === undefined) ev.sigDensity = signalDensity(ev);
    return ev.sigDensity;
  });
  const sorted = raw.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const p50 = at(0.5);
  const p90 = at(0.9);
  const p95 = at(0.95);
  const span = p90 - p50;
  const hiSpan = p95 - p90;
  for (let i = 0; i < events.length; i++) {
    const d = raw[i];
    let m = 1;
    if (span > 1e-9 && d > p50) {
      const t = (d - p50) / span;                       // p50→1, p90→1 满格起点
      if (d <= p90) {
        m = 1 + 0.15 * t;
      } else if (hiSpan <= 1e-9 || d <= p95) {
        // p90 → p95：继续升到峰值 1.28
        m = 1.15 + 0.13 * Math.min((d - p90) / Math.max(hiSpan, 1e-9), 1);
      } else {
        // p95 以上：**回落**（Yerkes-Dodson 后半段）
        //
        // 唤醒度和记忆强度不是单调关系，是倒 U：中等唤醒记得最牢，极高唤醒反而损害
        // 编码 —— 人会用屏蔽/解离处理过量情绪，留下的是碎片而不是更清晰的记录。
        // 早期的实现单调升到 1.35 封顶，等于假设「越激烈越难忘」，那是错的。
        m = 1.28 - 0.18 * Math.min((d - p95) / Math.max(hiSpan, 1e-9), 1);
      }
    }
    events[i].salience = Math.round(m * 1000) / 1000;
  }
}

/**
 * 间隔效应（spacing effect）加成，返回 1.0 ~ 1.5 的乘数。
 *
 * 人类记忆的巩固取决于提取的**分布**，不只是次数：
 *   - 一天里连着查 5 遍：几乎不留痕（massed practice）
 *   - 隔天各查一遍：记得很久（spaced practice）
 * 这就是「合意困难」—— 提取时越费劲，巩固越强。
 *
 * 注意别把「不均匀」当成「分散」：早期版本用间隔的变异系数（cv）当分散度，
 * 结果一串均匀的隔天提取 cv=0，被判定成「极度密集」反而零加成 —— 方向是反的。
 * 真正决定巩固的是**平均间隔本身的长短**：1 分钟一次和 1 天一次，间隔都很均匀，
 * 但后者才叫分散复习。
 *
 * 三个分量：
 *   gapScore  平均间隔（天）取对数，7 天满格 —— 主项
 *   rising    间隔是否递增（后面比前面长）—— 最理想的复习节奏，额外小加分
 *   stale     距上次提取已过多久 —— 隔得久还被想起，说明痕迹深
 *
 * 少于两次提取时没有间隔信息，返回 1，不奖不罚。
 */
export function spacingOf(ts, now = Date.now()) {
  if (!Array.isArray(ts) || ts.length < 2) return 1;
  const times = [];
  for (const t of ts) {
    const v = new Date(t).getTime();
    if (Number.isFinite(v)) times.push(v);
  }
  if (times.length < 2) return 1;
  times.sort((a, b) => a - b);

  const n = times.length;
  const spanDays = (times[n - 1] - times[0]) / 86400000;
  const avgGap = spanDays / (n - 1);                       // 平均间隔（天）
  if (!(avgGap > 0)) return 1;                             // 全在同一瞬间：massed，零加成

  const gapScore = Math.min(Math.log(1 + avgGap) / Math.log(8), 1);   // 7 天 → 满格

  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push((times[i] - times[i - 1]) / 86400000);
  let rising = 0;
  if (gaps.length >= 2) {
    let up = 0;
    for (let i = 1; i < gaps.length; i++) if (gaps[i] >= gaps[i - 1]) up++;
    rising = up / (gaps.length - 1);
  }

  const lastGap = Math.max((now - times[n - 1]) / 86400000, 0);
  const stale = Math.min(Math.log(1 + lastGap) / Math.log(31), 1);    // 30 天封顶

  return Math.round((1 + 0.30 * gapScore + 0.10 * rising + 0.10 * stale) * 1000) / 1000;
}

/** 清洗一行：去 markdown 符号、剔除标签残留 */
export function cleanLine(line) {
  const raw = String(line).trim();
  // HTML 注释（包括 memory 文件里的 dsh-note 标记）不进摘要
  if (/^<!--/.test(raw)) return '';
  if (/<!--.*-->/.test(raw)) return '';
  const s = raw.replace(/[`*#|>]/g, '').trim();
  if (s.length < 4) return '';
  if (JUNK.test(s)) return '';
  if (/^<\/?[a-z][a-z-]*$/i.test(s)) return '';
  if (/^(分析|思考|工具调用|收尾|开头)$/.test(s)) return '';
  if (/^<(tooltip|analysis|assistant|summary|thinking)\b/i.test(s)) return '';
  // 以前这里会把「>50 字符且不含中文」的行整行丢掉，理由是「像过程叙述」。
  // 代价是纯英文事件的头尾全空：摘要读不出那天在干什么，检索也扫不到线索。
  // 噪声最多让首句难看一点，丢内容却会让摘要直接失去意义，所以改为一律保留。
  return s;
}

function firstLine(texts) {
  for (const t of texts || []) {
    for (const line of String(t).split('\n')) {
      const s = cleanLine(line);
      if (s) return s;
    }
  }
  return '';
}

function lastLine(texts) {
  const arr = (texts || []).slice().reverse();
  for (const t of arr) {
    const lines = String(t).split('\n').reverse();
    for (const line of lines) {
      const s = cleanLine(line);
      if (s) return s;
    }
  }
  return '';
}

// 行尾可带 <!-- m_YYYYMMDD_NNNNNN --> 锚点；旧文件没有锚点，用位置兜底编号
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s+［(.+?)］(?:\s*<!--\s*(m_[0-9]{8}_[0-9a-f]{6})\s*-->)?\s*$/;
const LITERAL_HEAD = '<!-- dsh-note:literal-head:7f3a -->';

/**
 * Make legacy duplicate anchors unique without changing the first occurrence.
 *
 * Older imports used a content-only SHA-1 anchor, so repeated messages on one
 * day share an id. That breaks raw lookup and makes the first id collide as a
 * vector key. The first occurrence remains stable for old digest references;
 * later occurrences get a deterministic id derived from the old id, position,
 * role and text. A repair tool can persist these ids back to disk.
 */
export function normalizeEntryIds(entries) {
  const counts = new Map();
  const used = new Set();
  for (const entry of entries || []) {
    const original = entry.id;
    const ordinal = (counts.get(original) || 0) + 1;
    counts.set(original, ordinal);
    if (!original || ordinal === 1) {
      if (entry.id) used.add(entry.id);
      continue;
    }
    let salt = 0;
    let id;
    do {
      const key = `${original}\\0${entry.at}\\0${entry.who}\\0${entry.text}\\0${ordinal}\\0${salt++}`;
      id = `m_${entry.day.replace(/-/g, '')}_${createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
    } while (used.has(id));
    entry.id = id;
    used.add(id);
  }
  return entries;
}

/**
 * 单日文件解析缓存（0.4.1）
 *
 * 为什么要它：`readEntries` 以前每次调用都全量读并解析**所有**天的 md —— 这是
 * 「对话越长越慢」的根因。实测 2.16 MB / 21 天 20 ms、6.48 MB / 63 天 54 ms、
 * 10.8 MB / 105 ms，完全线性。而实际每次变化的通常只有**今天这一个文件**
 * （采集器追加写入），其余 99% 的开销都是白读。
 *
 * 缓存键用绝对路径（同一进程可能切不同记忆目录），失效条件是 size + mtimeMs。
 * mtimeMs 是浮点毫秒，够区分同一秒内的两次写入；再加 size 双保险。
 *
 * 内存：缓存持有已解析的条目对象。3000 条约 6 MB，10 万条约 200 MB —— 所以设
 * `FILE_CACHE_MAX` 上限，超出按最久未用淘汰（LRU）。正常使用（一天一个文件）
 * 十年也到不了 3650 个，上限只防异常目录。
 */
const FILE_CACHE_MAX = 1024;
const fileCache = new Map();   // absPath -> { size, mtimeMs, day, entries }

function parseDayFile(raw, day) {
  const entries = [];
  let cur = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^<!-- dsh-note:auto-(?:begin|end):7f3a -->$/.test(line)) {
      if (cur) { entries.push(cur); cur = null; }
      continue;
    }
    if (line.startsWith(LITERAL_HEAD)) {
      if (cur) cur.buf.push(line.slice(LITERAL_HEAD.length));
      continue;
    }
    const mm = DAY_RE.exec(line);
    // A body can quote an unanchored header from another date. Legacy imports
    // keep anchored cross-file records, but an unanchored cross-file line is
    // text, not a new entry. This prevents current chat explanations from
    // becoming phantom historical events.
    if (mm && !mm[5] && mm[1] !== day) {
      if (cur) cur.buf.push(line);
      continue;
    }
    if (mm) {
      if (cur) entries.push(cur);
      const [, d, hh, mi, who, anchored] = mm;
      cur = {
        day: d, hhmm: `${hh}:${mi}`, who,
        at: new Date(`${d}T${hh}:${mi}:00`).getTime(),
        id: anchored || null,
        buf: [],
      };
    } else if (cur) {
      if (/^<!-- memory-source:[0-9a-f]{64} -->$/.test(line)) continue;
      cur.buf.push(line);
    }
  }
  if (cur) entries.push(cur);

  // 兜底 id 按天内的出现顺序编号，天与天之间互不干扰 ——
  // 所以一个文件可以脱离其它文件独立算 id（同一天的所有条目必在同一文件里）。
  let seq = 0;
  for (const e of entries) {
    e.text = e.buf.join('\n').trim();
    delete e.buf;                       // 缓存里不再保留原始行数组，省一半内存
    if (!e.id) {
      seq += 1;
      e.id = `m_${e.day.replace(/-/g, '')}_${String(seq).padStart(6, '0')}`;
    }
  }
  normalizeEntryIds(entries);
  return entries;
}

export function readEntries(memDir) {
  const out = [];
  if (!existsSync(memDir)) return out;
  const live = new Set();

  for (const fn of readdirSync(memDir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(fn);
    if (!m) continue;
    const full = join(memDir, fn);
    live.add(full);
    let st;
    try { st = statSync(full); } catch { continue; }

    const hit = fileCache.get(full);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      // LRU：命中即刷新顺序（Map 保序，删了再插就排到最后）
      fileCache.delete(full);
      fileCache.set(full, hit);
      for (const e of hit.entries) out.push(e);
      continue;
    }

    let raw;
    try { raw = readFileSync(full, 'utf8'); } catch { continue; }
    const entries = parseDayFile(raw, m[1]);
    fileCache.set(full, { size: st.size, mtimeMs: st.mtimeMs, day: m[1], entries });
    for (const e of entries) out.push(e);
  }

  // 已经不存在的文件（被删/被改名）从缓存里摘掉，否则目录切换后旧条目会一直占内存
  for (const k of fileCache.keys()) {
    if (!live.has(k)) fileCache.delete(k);
  }
  // LRU 上限
  while (fileCache.size > FILE_CACHE_MAX) {
    const oldest = fileCache.keys().next().value;
    fileCache.delete(oldest);
  }

  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 清空解析缓存：测试和「换了记忆目录」时用 */
export function clearEntryCache() {
  fileCache.clear();
}

/**
 * 聚类结果缓存（0.4.1 增量）
 *
 * 聚类的状态机是严格顺序的：条目 i 是否并入当前事件，只取决于「当前事件的累积
 * 词集」和「与上一条的间隔」，不依赖后面的条目。所以只要**前面的条目没变**，
 * 它们的聚类结果就一定不变 —— 唯一可能受影响的是「最后一个还没封口的事件」，
 * 因为新条目可能延长它。
 *
 * 实测：2.16 MB / 151 事件全量聚类 51 ms，而每次工具调用真正变化的通常只有
 * 今天那一个文件的尾部几条。增量后只处理「最后一天新增的部分」。
 *
 * 前缀用**对象引用**比较：readEntries 命中文件缓存时返回的是同一批条目对象，
 * 引用相等 ⇒ 内容相等，比逐个字段比对快得多（且不会误判）。
 */
let clusterState = null;   // { entries, events }

/** 把条目聚成事件（增量：复用未变化的前缀）
 *
 * @param {Array} entries readEntries 的结果
 * @param {{labelStore?: {map: Object, dirty: boolean}, setState?: boolean}} [opts]
 *        labelStore 是主题线标签仓库，由调用方持有并持久化。传 null 则每次现算。
 *        setState=false 时**不改动全局 clusterState** —— 给「只要事件、不要主题线」的
 *        调用方用（buildDailies 就是）：它那条路径没有 labelStore，若允许覆盖全局状态，
 *        下一次 currentThreads() 拿到的就是一份没走持久化的 threads，注入里的标签
 *        会跟着数据抖动。0.6.0 部署后现场就是这样：同一小时内 `headchars`→`tailchars`
 *        →`ef5aff9` 换了三次，而 _threads.json 一次都没被写过。
 */
export function clusterEvents(entries, opts = {}) {
  let p = 0;
  let reuse = 0;
  let prevEvents = null;

  // ── 前缀复用 ──────────────────────────────────────────────────────
  //
  // 两条路：
  //   ① **进程内**（clusterState）：逐条比对象身份 `prev[p] === entries[p]`。
  //      readEntries 的文件缓存会返回同一批对象，所以这条通常成立。
  //   ② **跨进程**（opts.seed）：调用方已经用**文件指纹**（size+mtimeMs）证明
  //      「前 seed.entryCount 条内容没变」，直接信任，跳过 O(n) 的身份比对。
  //
  // 第 ② 条是 0.14.0 加的，为了「无限对话」：语料长到 10 万条时，
  // 每次启动重算要 438 ms，而文件指纹只要几十微秒。
  //
  // **安全性来源**：调用方必须用 persist.js 的 diffIndex 验过指纹。
  // 指纹只含 size+mtimeMs —— 内容变了但大小和时间都没变的情况理论上存在
  // （原地改一个字节且 mtime 被伪造），那种情况会读到旧事件。这是刻意的权衡：
  // 手工伪造 mtime 不是正常使用方式，为它每次跑全量不值得。
  if (opts.seed && Number.isSafeInteger(opts.seed.entryCount)
      && opts.seed.entryCount <= entries.length
      && Array.isArray(opts.seed.events)) {
    p = opts.seed.entryCount;
    prevEvents = opts.seed.events;
    // 只有完全落在种子前缀内、且已封口的事件能复用
    for (let i = 0; i < prevEvents.length; i++) {
      if (prevEvents[i].endIdx < p) reuse = i + 1;
      else break;
    }
  } else if (clusterState && clusterState.entries) {
    const prev = clusterState.entries;
    const n = Math.min(prev.length, entries.length);
    while (p < n && prev[p] === entries[p]) p++;
    if (p === entries.length && p === prev.length) return clusterState.events;   // 完全没变
    prevEvents = clusterState.events;
    // 只有「完全落在公共前缀内」的事件能安全复用；
    // 碰到第一个跨过前缀边界的事件就停 —— 它可能就是被延长或截断的那个。
    for (let i = 0; i < prevEvents.length; i++) {
      if (prevEvents[i].endIdx < p) reuse = i + 1;
      else break;
    }
  }

  // 复用是**浅拷贝**：events 里放的是上一轮 clusterState 里的同一批事件对象，
  // 下面的循环会原地改 cur 的 lastAt / endIdx / items / texts / toks。
  //
  // 不变量（改这里之前先读）：
  //   ① 被复用的事件，其 endIdx < 本次的前缀长度 p，即它的全部条目都没变；
  //   ② 只允许「追加」，不允许「合并、截断、重排」已有事件 —— 那些操作会让复用对象
  //      与 entries 失去对应关系，而且不会崩，只会让分级悄悄偏移。
  //   ③ clusterState.entries 必须与这批对象同时更新（下面最后一行），否则下一次
  //      前缀比较会拿旧 entries 对不上新对象，退化成全量重算（只是慢，不会错）。
  //
  // 之所以不深拷贝：150 个事件 × 平均 20 条条目，每次工具调用复制一遍是纯浪费；
  // 而上面的不变量在当前代码里是成立的（endIdx 单调递增，越界即停止复用）。
  const events = reuse > 0 ? prevEvents.slice(0, reuse) : [];
  const from = reuse > 0 ? prevEvents[reuse - 1].endIdx + 1 : 0;
  // cur 指向复用出来的最后一个事件：它还没封口，新条目仍可能并入它。
  // 这正是全量算法的状态，所以「继续跑」得到的结果与全量逐条一致。
  //
  // setState=false 时**必须复制一个**：复用的是上一轮 clusterState 里的同一批对象，
  // 原地改 cur 的 items/texts/ids/toks 会同时改掉 clusterState.events 里的那个对象，
  // 于是「只读调用」变成了「改了全局状态」—— clusterState.entries 还是旧的、
  // events 最后一个已经多出若干条，两边对不上。当前没有代码在那之后读它，所以不炸；
  // 但这是靠调用顺序站住的正确性，属于设计债。低频路径（buildDailies）多复制一个
  // 事件，代价可以忽略。
  let cur = null;
  if (events.length) {
    const last = events[events.length - 1];
    cur = opts.setState === false
      ? { ...last, items: [...last.items], texts: [...last.texts], ids: [...last.ids], toks: new Set(last.toks) }
      : last;
    events[events.length - 1] = cur;
  }

  for (let i = from; i < entries.length; i++) {
    const e = entries[i];
    const toks = tokens(e.text);
    toks.delete(''); // 保险
    for (const s of STOP) toks.delete(s);

    let join = false;
    if (cur) {
      const gapMin = (e.at - cur.lastAt) / 60000;
      const sim = jaccard(toks, cur.toks);
      join = gapMin <= GAP_MIN || (gapMin <= 180 && sim >= 0.18);
      // 条数上限：聊得再连贯也不能无限并，否则一天只剩一个大事件，
      // 摘要退化成一坨、检索也就没用了。
      if (join && cur.items.length >= MAX_EVENT_ITEMS) join = false;
    }
    if (!join) {
      cur = {
        startAt: e.at, lastAt: e.at, day: e.day,
        items: [], toks: new Set(), texts: [], ids: [],
        startIdx: i, endIdx: i,
      };
      events.push(cur);
    }
    cur.lastAt = e.at;
    cur.day = e.day;
    cur.endIdx = i;
    cur.items.push(e);
    cur.texts.push(e.text);
    if (e.id) cur.ids.push(e.id);
    for (const t of toks) {
      if (cur.toks.size > 800) break;
      cur.toks.add(t);
    }
  }

  // 情绪显著度只依赖事件文本，与 now 无关。原始信号密度按事件缓存（sigDensity），
  // 增量时只重算「被延长的那一个 + 新增的」，其余直接复用。
  const dirty = Math.max(reuse - 1, 0);
  for (let i = dirty; i < events.length; i++) {
    events[i].sigDensity = signalDensity(events[i]);
    events[i].openness = opennessOf(events[i]);
  }
  salienceAll(events);

  // 实体指纹与主题线（0.5.0）：只依赖词集与全局 DF，与 now 无关，随 cluster 缓存。
  // 顺手把 df 预热进 docFreq 的 WeakMap —— gradeEvents 马上要用同一份，
  // 这里算过就不会再遍历一遍 8 万个 token。
  const { df, N } = docFreq(events);
  for (const ev of events) ev.entities = entitiesOf(ev, df, N);
  // 位置效应必须在全量事件上算（复用前缀的事件也要重新定位），一次 O(n) 排序很便宜
  applySerialPosition(events);
  const threads = linkThreads(events, opts.labelStore || null);

  // setState=false：算完只把 events 交出去，不碰全局状态。
  // 增量缓存也跟着不动 —— 否则下次 build() 会拿到一份「entries 是旧的、events 是新的」
  // 的错配状态，前缀比较直接失效。
  if (opts.setState !== false) clusterState = { entries, events, threads };
  return events;
}

/** 取最近一次聚类算出的主题线（renderForPrompt 用；没算过返回空） */
export function currentThreads() {
  return clusterState ? clusterState.threads : [];
}

/** 清空聚类缓存（测试与切换目录时用） */
export function clearClusterCache() {
  clusterState = null;
}

/**
 * 实体指纹（0.5.0）
 *
 * 「主题线」要判断两段对话是不是在说同一件事。前面试过词集 Jaccard、共享稀有词数，
 * 都不行 —— 中文二元切词下事件平均 546 个 token，同天事件对 Jaccard 最高只有 0.26，
 * 而「共享稀有词」会把 QQ 群闲聊和插件调试判成同一件事（它们共享 50 个高频技术词）。
 *
 * 换成**标识符指纹**之后才分得开：真实的工作线索留下的痕迹是具体的 —— 文件名、
 * 函数名、哈希、常量名。`eada617`、`getSnapshot`、`thresholdChars` 这些东西
 * 不会在闲聊里出现，也不会跨话题重合。
 *
 * 判据（三条同时满足）：
 *   长度 >= 7 或含下划线 —— 排除 begin / notes / users 这类通用短词
 *   含至少一个字母       —— 排除 3603 / 4521 这类行号与字节数
 *   df <= maxDf          —— 全库最多这么多个事件用过，才有辨识度
 *
 * **df 上限必须随数据量缩放**：写死 3 的话，同一个词在 3 倍数据里自然出现 3 次以上，
 * 整个指纹表会被清空（实测把 21 天数据复制 5 份后，线数从 3 掉到 0）。所以按 N/50
 * 抬上限，保证「稀有」始终是相对当前语料而言的。
 *
 * 实测（21 天 / 152 事件真实数据）：同天指纹重合 >= 3 的只有 13 对，人工看全是
 * 真相关（发布链路、面板调试、purge 移植）；跨天重合 >= 4 只有 3 对，也全对。
 */
export const ENT_MIN_LEN = 7;
/**
 * 每个事件保留多少个实体（0.5.3 从 24 提到 40）
 *
 * 为什么要扩大：实体是按「df 小的优先」挑的，而 df 随每次新增消息变化。池子只有 24
 * 个时，新消息挤进几个常见词就会把原来选中的挤出去，两条事件的交集随之跌破阈值、
 * 线断掉 —— 实测同一段历史在两条消息之间就从「3 件 63 条」变成「2 件 35 条」。
 * 池子放大后，边缘位置的名次波动不再影响交集。
 */
export const ENT_KEEP = 40;

export function entitiesOf(ev, df, N = 1) {
  const maxDf = Math.max(3, Math.round(N / 50));
  const out = [];
  for (const t of ev.toks) {
    if (t.length < ENT_MIN_LEN && !t.includes('_')) continue;
    if (!/[a-z]/.test(t)) continue;
    if ((df.get(t) || 0) > maxDf) continue;
    out.push(t);
  }
  // df 小的优先，同样稀有取更长的（更可能是指标符而非普通长词）。
  // 最后用字典序兜底：不写这一层的话，df 与长度都相同的词会按 Set 的遍历顺序排，
  // 而那取决于插入顺序 —— 同一份数据两次运行可能得到不同的实体集，主题线跟着抖。
  out.sort((a, b) => ((df.get(a) || 0) - (df.get(b) || 0)) || (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0));
  return new Set(out.slice(0, ENT_KEEP));
}

/** 两条线的实体重合判定：同天 3 个，跨天 3 个
 *
 * 跨天从 4 降到 3（0.5.3）：实体池随 df 波动，边缘名次会被新消息挤动，卡在 4 上的
 * 线一有风吹草动就断。阈值降到 3 之后同样的历史能稳住，误连风险由「实体必须是标识符」
 * 这条前置条件兜着（`begin`/`notes` 那种通用词根本进不了池子）。
 */
export const THREAD_SAME_DAY = 3;
export const THREAD_CROSS_DAY = 3;

/**
 * 系列位置效应（serial position effect，0.8.0）
 *
 * 人回想一段连续经历时，记得最清的是**开头和结尾**，中间最模糊。
 * 两个机制不同：开头有更多加工时间（进了长期记忆，primacy），结尾还留在短期缓冲里
 * （recency）。合起来是一条 U 形曲线。
 *
 * 这里按「日内序列」算：一天里最早与最晚的事件 +10%，次早/次晚 +5%，中间不加。
 * 一天只有一个事件时不加 —— 它既是开头又是结尾，没有位置对比可言。
 *
 * **为什么按天不按主题线**：位置效应是「同一段连续经历」内部的，一天是自然的边界
 * （人按天划分经历）。按主题线算会让跨度几天的线里「第一天开头」和「最后一天结尾」
 * 彼此加成，那不是位置效应。
 */
export function applySerialPosition(events) {
  const byDay = new Map();
  for (const ev of events) {
    let list = byDay.get(ev.day);
    if (!list) { list = []; byDay.set(ev.day, list); }
    list.push(ev);
  }
  for (const list of byDay.values()) {
    if (list.length < 2) {
      for (const e of list) e.serial = 1;
      continue;
    }
    list.sort((a, b) => a.startAt - b.startAt);
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const d = Math.min(i, n - 1 - i);       // 离两端最近的距离
      list[i].serial = d === 0 ? 1.10 : d === 1 ? 1.05 : 1;
    }
  }
}

/**
 * 把事件串成「主题线」。
 *
 * 这是插件原始承诺（「上千条对话压成几百字索引」）真正该有的形态：人回想事情不是
 * 按「哪天哪条」，而是按「那条线」—— 「我在改这个插件」「发布链路那摊事」。
 * 0.4.x 的注入只是把事件按等级罗列，读起来更像日志而不是记忆。
 *
 * 用并查集：同天重合 >= 3 或跨天重合 >= 3 就并到一起。链式传递（A-B、B-C 但 A-C
 * 不重合）也算一条线 —— 真实的事情本来就是这样推进的。
 *
 * ── 标签持久化（0.6.0）────────────────────────────────────────────
 * 标签以前每次现算，取「全体成员共享的最短实体」。成员里一旦掺进新事件，共享实体
 * 集合就变，标签跟着换 —— 实测同一条线（成员一个没动）在几小时内从 `nativeauth`
 * 变成 `tenprotect`。成员稳定了、标签还在漂，看的人会以为这是两件事。
 *
 * 现在给它一个**不随数据变化的身份**：线内最早事件的 startAt（毫秒）。只要这条线
 * 的起点没变，就永远复用第一次算出来的标签。`labelStore` 由调用方持有并持久化到
 * `<DSH_HOME>/memory-notes/_threads.json`（与 `_access.json` 同级，不是 `_digest` ——
 * 那边是每日摘要会被重算/清理），本函数只读写不落盘（events.js 不做 IO）。
 *
 * @param {Array} events 已带 entities 的事件
 * @param {{map?: Object<string,string>, dirty?: boolean}|null} labelStore 标签仓库
 * @returns {Array<{members, startAt, lastAt, items, openness, head, label, since}>}
 */
export function linkThreads(events, labelStore = null) {
  const n = events.length;
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  // 倒排索引：实体 -> 出现过它的事件下标。
  // 之前是事件两两全比较（O(n²)），572 个事件就是 16 万对 —— 实测占掉冷启动 40ms。
  // 实际上绝大多数事件对**一个实体都不共享**，比较它们纯属浪费。走倒排之后只比较
  // 共享过实体的事件对，复杂度降到 O(Σ 每个实体的出现次数²)。
  const inv = new Map();
  for (let i = 0; i < n; i++) {
    const ents = events[i].entities;
    if (!ents || !ents.size) continue;
    for (const t of ents) {
      let l = inv.get(t);
      if (!l) { l = []; inv.set(t, l); }
      l.push(i);
    }
  }
  // 一个实体铺到 60 个以上事件里就太泛了（比如通用文件名），拿它当线索只会误连
  const pair = new Map();          // i*n+j -> 共享实体个数（i<j 恒成立，见下）
  for (const list of inv.values()) {
    const m = list.length;
    if (m < 2 || m > 60) continue;
    for (let a = 0; a < m; a++) {
      for (let b = a + 1; b < m; b++) {
        const k = list[a] * n + list[b];
        pair.set(k, (pair.get(k) || 0) + 1);
      }
    }
  }
  for (const [k, c] of pair) {
    const i = Math.floor(k / n);
    const j = k % n;
    const need = events[i].day === events[j].day ? THREAD_SAME_DAY : THREAD_CROSS_DAY;
    if (c >= need) union(i, j);
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(events[i]);
  }

  const threads = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;          // 单件不成线，仍走原来的等级注入
    const startAt = Math.min(...members.map((m) => m.startAt));
    const lastAt = Math.max(...members.map((m) => m.lastAt));
    // 只认**跨天**的线。同一天里两条内容相近的事件是「同一次讨论」，本来就该
    // 分开列（那不是推进，是重复）；真正值得当成一条线看的是「隔了几天还在弄
    // 这件事」—— 那才是记忆里的「图式」。
    if (dayOf(startAt) === dayOf(lastAt)) continue;
    const items = members.reduce((a, m) => a + m.items.length, 0);
    // 线的未完成度取成员最大值：线上只要有一件还没着落，这条线就是没完的事。
    // 用平均会被已完成的那几件稀释掉（实测 5 件里有 1 件开着，平均只剩 0.06）。
    const openness = Math.max(...members.map((m) => m.openness || 0));

    // ── 图式强度（schema strength，0.11.0）────────────────────────────
    // 真实记忆是分层的：具体经历（事件）之上还有「图式」——反复出现的事情被抽成一套
    // 剧本，之后再遇到类似的就不需要记住每个细节了（Bartlett 1932 的重构记忆）。
    // 例如「每次发布都要跑一遍四套测试」这条规则，比「11-15 那天我跑了四套测试」
    // 记得更久，也更该占据有限的注入空间。
    //
    // 结构项和事件强度同形，但**用成员总条数而不是成员个数** —— 用个数的话尺度会
    // 比事件 S 小一个量级（5 件 → ln6=1.8，而 28 条消息的事件是 ln29=3.4），
    // 阈值永远够不到。用总条数才可比。
    const spanDays = Math.max(1, Math.round((lastAt - startAt) / 86400000) + 1);
    const S_line = Math.log(1 + items) * (1 + 0.3 * Math.log(1 + spanDays));
    // 打在每个成员上，供 gradeEvents 的 rank 使用（不改 level，只影响排位 ——
    // 细节不该消失，只是让位）。
    for (const m of members) m.threadS = S_line;

    // 线的身份 = 起点事件的毫秒时间戳。起点不变，标签就不变。
    const storeKey = String(startAt);
    let label = '';
    let since = 0;                       // 标签是哪一轮定下来的（0 = 本次新定）
    const stored = labelStore && labelStore.map ? labelStore.map[storeKey] : null;
    if (stored && typeof stored === 'object' && stored.label) {
      label = stored.label;
      since = stored.at || 0;
    } else if (typeof stored === 'string' && stored) {
      label = stored;                    // 兼容早期只存字符串的格式
    }

    if (!label) {
      let common = null;
      for (const t of members[0].entities) {
        if (![...members].every((m) => m.entities.has(t))) continue;
        // 全体共享的实体里取**最短**的，不是最长的。
        // 取最长会系统性偏向底层实现名（makematcher / getboundingclientrect / toisostring），
        // 那对「这条线在做什么」毫无说明力；短的那个通常才是主题词（publish / config）。
        // 反正都过了「长度 >= 7 且是标识符」这道关，不会有 json/error 这种进来。
        if (!common || t.length < common.length) common = t;
      }
      if (common) {
        label = common;
      } else {
        // 没有全体共享的实体（链式相连的线本来就这样），退一步取「出现次数最多」的
        // 实体 —— 它仍然是有辨识度的锚点。
        // 最后才用首句：首句常常是半句话（「等一下，文件从…」），当标题很糟，
        // 只在前两条路都走不通时兜底。
        const cnt = new Map();
        for (const m of members) for (const t of m.entities) cnt.set(t, (cnt.get(t) || 0) + 1);
        let best = null;
        let bestN = 1;
        for (const [t, c] of cnt) {
          if (c > bestN || (c === bestN && best && t.length > best.length)) { best = t; bestN = c; }
        }
        if (best) label = best;
        else {
          const first = members.slice().sort((a, b) => a.startAt - b.startAt)[0];
          label = (first.texts && first.texts[0] ? first.texts[0] : '').replace(/[`*#|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 26);
        }
      }
      // 定下来就存住：下次成员再怎么变，这条线还叫这个名字。
      if (labelStore && labelStore.map && label) {
        labelStore.map[storeKey] = { label, at: Date.now() };
        labelStore.dirty = true;
        since = Date.now();
      }
    }
    threads.push({ members, startAt, lastAt, items, openness, label, since });
  }
  // 排前面的是「件数多、且最近还在动」的线 —— 那才是当下正在推进的事
  threads.sort((a, b) => (b.members.length - a.members.length) || (b.lastAt - a.lastAt));
  return threads;
}

/**
 * 未完成度（蔡加尼克效应，0.4.2）
 *
 * Zeigarnik (1927)：被打断的、未完成的任务比已完成的更容易被记住、也更容易
 * 反复闯进意识 —— 因为目标状态还没达成，认知系统持续给它分配资源。
 *
 * 插件这边对应的错：一条「待办 / 还差 / 下一步」和一条「搞定了」在同一套公式下
 * 完全等价，于是已经收尾的事和还没着落的事一起衰减，而人真正该惦记的是后者。
 *
 * 用可计算的信号差来代理：
 *   未完成 —— 待办、还差、没做、下一步、剩下、下次、继续、暂不、遗留、TODO
 *   已完成 —— 搞定、完成、通过、修好、上线、解决、跑通、收尾、结束
 *
 * 返回 -1 ~ 1（负数是"明显已经收尾"），乘进 S 时映射成 1 - 0.25·openness，
 * 即未完成的最多慢衰 25%、已完成的最多快衰 25%。
 */
const OPEN_SIGNAL = /待办|todo|fixme|下一步|还没做|还没弄|还没修|没搞定|还差|剩下|遗留|搁置|暂不|先不|待确认|待验证|尚未|未完成|没跑|没测/gi;
const DONE_SIGNAL = /搞定|修好了|跑通了|上线了|合入了|收尾了|已完成|全部通过|全部修完|解决了|弄好了|验证过了/gi;

export function opennessOf(ev) {
  const txt = (ev.texts || []).join('\n');
  if (!txt) return 0;
  const o = (txt.match(OPEN_SIGNAL) || []).length;
  const d = (txt.match(DONE_SIGNAL) || []).length;
  // 净信号要有绝对量才作数：28 条消息里出现 1 个「下一步」不代表这件事没着落。
  // 同时按条数归一，避免长对话天然占优。
  const net = o - d;
  if (Math.abs(net) < 3) return 0;
  const n = Math.max((ev.items || []).length, 1);
  return Math.max(-1, Math.min(1, net / n));
}

/**
 * 文档频率（DF）缓存。
 *
 * DF 只依赖事件的词集，不依赖 now —— 但它是 gradeEvents 里最贵的一步（遍历全部
 * 事件的全部 token）。以前的实现每次工具调用都重算一遍，等于「每条记忆都被数了
 * 一次词频」。用 events 数组对象本身做 WeakMap 键：cluster 重建时数组换新，缓存
 * 自然失效，不需要手动清理，也不会留下悬空引用。
 */
const dfCache = new WeakMap();

function docFreq(events) {
  const hit = dfCache.get(events);
  if (hit) return hit;
  const df = new Map();
  for (const ev of events) {
    for (const t of ev.toks) df.set(t, (df.get(t) || 0) + 1);
  }
  const value = { df, N: Math.max(events.length, 1) };
  dfCache.set(events, value);
  return value;
}

/**
 * 幂律遗忘曲线。
 *
 * 0.3.x 用的是指数衰减 `R = exp(-t/S)`，但人类遗忘的实证拟合（Wixted & Ebbesen
 * 1991、Anderson & Schooler 1991）更接近**幂函数**：长尾明显更厚 —— 很久以前的事
 * 不会瞬间归零，而是变得模糊、要靠线索才想得起。指数曲线会把三个月前的一切统统压
 * 到 L5，不符合直觉，也让「历史补位」永远缺货。
 *
 * 取 `R = (1 + K·x)^(-β)`，x = 距今小时 / (S·24)：
 *   β = 0.5   —— 实证区间 0.4~0.8 的中低端，长尾够厚又不至于「什么都记得」
 *   K = 6.39  —— 令 x=1 处 R=0.368（与指数曲线的半衰点对齐），保证 S 的
 *                「天数」语义在两条曲线下可比，历史数据的阈值不用整体重标定
 *
 * 对照：x=1 时两者都 0.368；x=3 时指数 0.050、幂律 0.223；x=10 时指数 5e-5、
 * 幂律 0.124。差别全在长尾。
 */
export const POWER_BETA = 0.5;
export const POWER_K = 6.39;

/**
 * 睡眠巩固（sleep-dependent consolidation，0.8.0）
 *
 * 真实的记忆巩固主要发生在**睡眠期间**：海马体在慢波睡眠里把当天的经历重放给皮层，
 * 这一步离线完成，不占清醒时的认知资源。所以「隔一夜」和「隔一个白天」在记忆上不等价 ——
 * 同样 24 小时，前者跨了一次睡眠，后者没有。
 *
 * 现在 `ageH` 只算绝对时间差，两者一视同仁。这一层把跨夜次数算出来，用它**折扣衰减的
 * 速度**：跨过 4 夜的事件，同样日历时间下留存更高。
 *
 * 为什么乘在 R 的 ageH 上、而不是乘进 S：
 *   S 是「当初记得多牢」，是个不随 now 变化的属性；跨夜次数每天都在涨，乘进 S 会让
 *   「同一件旧事的 S 越来越大」——语义就错了。这里要表达的是「时间对它的侵蚀变慢了」。
 */
export function nightsBetween(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  const a = new Date(fromMs);
  const b = new Date(toMs);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.max(0, Math.round((db - da) / 86400000));
}

/** 跨夜一次的巩固加成；封顶 4 次（再多的夜对模型没有增量信息，真实巩固也早饱和了） */
export const CONSOLIDATION_PER_NIGHT = 0.06;
export const CONSOLIDATION_MAX_NIGHTS = 4;

export function consolidationOf(anchorMs, nowMs) {
  const nights = nightsBetween(anchorMs, nowMs);
  return {
    nights,
    factor: 1 + CONSOLIDATION_PER_NIGHT * Math.min(nights, CONSOLIDATION_MAX_NIGHTS),
  };
}

/** 纯数字 / 十六进制碎片，做主题词没有信息量（7811 / 0x1c / 113mb） */
const JUNK_TOK = /^(0x)?[0-9a-f]{2,}$|^\d+[a-z]{1,3}$/i;

/**
 * 主题词缓存（0.4.1）
 *
 * 主题词只依赖事件的词集、DF 表与事件总数 N，**不依赖 now** —— 但在 0.3.x 里它
 * 被塞在 gradeEvents 的主循环里，于是每次工具调用都重算一遍。实测 152 个事件、
 * 8.3 万个 token，光是这一步就 20.5 ms，占 gradeEvents 总耗时（20.6 ms）的 99%。
 *
 * 缓存键 = 条数 | 词数 | N：事件被追加（条数或词数变）或总事件数变（IDF 变）时
 * 失效，否则直接复用。增量聚类下通常只有最后一个事件失效。
 */
const topicCache = new WeakMap();

function computeTopics(ev, df, N) {
  const K = 6;
  // idf <= 0.3 等价于 d >= N/e^0.3 - 1；先比次数，省掉每个 token 一次 Math.log
  const minDf = N / 1.3499 - 1;
  const best = [];                       // 按权重降序，最多 K 个
  for (const t of ev.toks) {
    const len = t.length;
    if (len < 2) continue;
    if ((df.get(t) || 1) >= minDf) continue;      // 太常见，没辨识度
    if (EN_STOP.has(t)) continue;
    if (JUNK_TOK.test(t)) continue;
    const idf = Math.log(N / (1 + (df.get(t) || 1)));
    const w = idf * Math.min(len, 4);
    // 比当前最差的一个还弱就直接丢，不做插入
    if (best.length === K && w <= best[K - 1].w) continue;
    let i = best.length;
    while (i > 0 && best[i - 1].w < w) i--;
    best.splice(i, 0, { t, w });
    if (best.length > K) best.pop();
  }
  return best.map((x) => x.t);
}

function topicsOf(ev, df, N) {
  const key = `${ev.items.length}|${ev.toks.size}|${N}`;
  const hit = topicCache.get(ev);
  if (hit && hit.key === key) return hit.topics;
  const topics = computeTopics(ev, df, N);
  topicCache.set(ev, { key, topics });
  return topics;
}

/** 给事件算强度与留存 */
export function gradeEvents(events, now = Date.now(), accessFn = null) {
  // IDF：词在多少事件里出现（结果按 events 数组缓存，见 docFreq）
  const { df, N } = docFreq(events);
  // eventKey 的撞号计数：同一分钟内出现多个事件时靠它加序号。
  const keyUse = new Map();

  const graded = events.map((ev, idx) => {
    const n = ev.items.length;
    const spanDays = Math.max(1, Math.round((ev.lastAt - ev.startAt) / 86400000) + 1);

    // 密度：条/小时，防止「一口气聊一百条」被当成超级大事
    const hours = Math.max((ev.lastAt - ev.startAt) / 3600000, 0.25);
    const density = Math.min(n / hours, 40);

    // 实证权重：这条路上的记忆被真正查过几次。查过就是投票，
    // 比单靠条数密度猜更可信。没查过则为 1，不奖不罚。
    const acc = accessFn ? accessFn(ev) : { n: 0, last: null, ts: [], suppress: 0 };
    // 提取强度：边际递减 —— 第 1 次提取的巩固价值远大于第 20 次。
    const retrieval = 1 + 0.18 * Math.log(1 + (acc.n || 0));

    // 间隔效应：分散提取 > 集中重复（见 spacingOf）
    const spacing = spacingOf(acc.ts, now);

    // 情绪显著度：cluster 阶段已算好，与 now 无关
    const salience = ev.salience || 1;

    // 蔡加尼克效应：没着落的事保持得更久，已收尾的事衰退更快（见 opennessOf）
    const open = ev.openness || 0;
    const zeigarnik = 1 + 0.25 * open;        // 0.75 ~ 1.25

    // 系列位置效应：一天里最早/最晚的事件记得更牢（见 applySerialPosition）
    const serial = ev.serial || 1;            // 1.10 / 1.05 / 1.0

    const S = Math.log(1 + n)
      * (1 + 0.35 * Math.log(1 + spanDays))
      * (1 + density / 60)
      * retrieval * spacing * salience * zeigarnik * serial;

    // 再巩固（reconsolidation）：衰减起点取「最近一次活动」与「最近一次被提取」中
    // 更晚的那个。真实记忆每被想起一次就重新固化一次，遗忘曲线从那一刻重新起算；
    // 只把提取加成塞进 S、却仍从原始时间点起算衰减，等于把「复习」当成了「内容更多」，
    // 结果一条被反复查阅的关键记忆照样会掉到 L5。这是 0.4.0 修正的核心偏差。
    const accessAt = acc.last ? new Date(acc.last).getTime() : 0;
    const anchor = Math.max(ev.lastAt, Number.isFinite(accessAt) ? accessAt : 0);
    const ageH = Math.max((now - anchor) / 3600000, 0);

    // 幂律遗忘。`consolidation` 折扣的是「时间侵蚀的速度」：跨过睡眠的记忆衰减更慢。
    // 乘在分母而不是乘进 S —— S 是「当初多牢」，不该随 now 涨（见 consolidationOf 注释）。
    const cons = consolidationOf(anchor, now);
    const R = Math.pow(1 + POWER_K * (ageH / (S * 24 * cons.factor)), -POWER_BETA);

    // 元认知置信度（metacognition，0.10.0）
    //
    // 人不是只有「记得 / 不记得」两档 —— 还知道自己**有多确定**。有些记忆清晰到能复述
    // 细节，有些只剩一个模糊轮廓（知道有这么件事，但说不清具体做了什么）。
    // 插件以前只给一个 R，模型没法区分「这条我确定」和「这条我大概记得」。
    //
    // 两个来源：
    //   recency   留存（R 高 = 还在），权重 0.6 —— 主要依据
    //   practice  被提取过多少次（对数，5 次算满分），权重 0.4 —— 反复想起过的更可靠
    // 从没被提取过、又放很久的，confidence 会很低 —— 那是「我以为我记得」。
    const practice = Math.min(1, Math.log(1 + (acc.n || 0)) / Math.log(6));
    const confidence = Math.max(0, Math.min(1, 0.6 * R + 0.4 * practice));

    // 主题词：取事件里 IDF 最高的几个（IDF 高 = 不常见 = 有辨识度）
    // 只依赖词集与 DF，与 now 无关 —— 走事件级缓存，不随每次工具调用重算。
    const scored = topicsOf(ev, df, N);

    const head = firstLine(ev.texts).slice(0, 90);
    const tail = lastLine(ev.texts).slice(0, 90);

    const ids = ev.ids || [];
    // 内容哈希 id 没有「连续」这个概念：hash 是随机的，两张哈希恰好十进制相邻
    // 只是巧合（如 000101 与 000102），据此写成 a..b 会让人以为中间那些也属于
    // 这个事件，而取文时只拿得到首尾两条 —— 静默丢条目。所以一律不声明连续，
    // 摘要只写 +N，取全量走 event 键。
    const contiguous = ids.length === 1;
    const idRange = !ids.length ? ''
      : contiguous ? ids[0]
      : `${ids[0]} +${ids.length - 1}（共 ${ids.length} 条，按 event 键取全量）`;
    // 稳定的机器可读键：日期 + 事件起始时分。摘要写它，raw 用它取精确 ID 数组。
    // 同一分钟内可能出现多个事件（批量导入、子代理并发），键会撞；撞了就加序号，
    // 否则 ids.json 后写覆盖先写，按事件键取全量会拿到别人的条目。
    const sd = new Date(ev.startAt);
    const baseKey = `e_${dayOf(ev.startAt).replace(/-/g, '')}_${String(sd.getHours()).padStart(2, '0')}${String(sd.getMinutes()).padStart(2, '0')}`;
    const seen = keyUse.get(baseKey) || 0;
    keyUse.set(baseKey, seen + 1);
    const eventKey = seen === 0 ? baseKey : `${baseKey}_${seen + 1}`;
    return {
      idx, day: ev.day, startAt: ev.startAt, lastAt: ev.lastAt, eventKey,
      ids, idRange, idsContiguous: contiguous,
      accessCount: acc.n || 0, lastAccess: acc.last || null,
      count: n, spanDays, ageH: Math.round(ageH * 10) / 10,
      anchorAt: Math.round(anchor),
      S: Math.round(S * 100) / 100,
      R: Math.round(R * 1000) / 1000,
      density: Math.round(density * 10) / 10,
      // 三个乘数的原始值：报告与调试要能看出「这条为什么高/为什么低」
      retrieval: Math.round(retrieval * 1000) / 1000,
      spacing: Math.round(spacing * 1000) / 1000,
      salience: Math.round(salience * 1000) / 1000,
      openness: Math.round(open * 1000) / 1000,
      // 蔡加尼克乘数回传：报告要能看出「这条为什么高/低」。它是唯一可以小于 1 的
      // 乘数（已收尾会扣分），所以报告那边得用绝对值判断要不要显示。
      zeigarnik: Math.round(zeigarnik * 1000) / 1000,
      // 提取诱发遗忘：这条被别的提取压住了多少（0~0.35）。只影响排序，不改 level ——
      // 被压住的仍然看得到，只是排后面。见 access.js 的 SUPPRESS_* 注释。
      suppress: Math.round((acc.suppress || 0) * 1000) / 1000,
      // 睡眠巩固：跨了几夜、折扣了多少衰减速度（1.0 ~ 1.24）。报告与测试要能看到。
      nights: cons.nights,
      consolidation: Math.round(cons.factor * 1000) / 1000,
      // 系列位置：1.10（当天首尾）/ 1.05（次首尾）/ 1.0（中间或当天只有一条）
      serial,
      // 图式强度：这条事件所属主题线的 S_line。≥4 时成员让位给抽象（只影响 rank）。
      threadS: Math.round((ev.threadS || 0) * 100) / 100,
      // 元认知：0~1，越低越模糊。注入时低于 0.25 会标 `~`
      confidence: Math.round(confidence * 1000) / 1000,
      topics: scored,
      head: head.slice(0, 90),
      tail: tail.slice(0, 90),
    };
  });

  // ── 第一道闸：绝对阈值 ───────────────────────────────────────────────
  // R 是「还剩多少」，S 是「当初多重」。两者都得够才算核心记忆：
  // 只有 R 高的是「刚才说的琐事」，只有 S 高的是「很久以前的大事」。
  //
  // 0.3.x 的阈值是按指数曲线标定的（0.72 / 0.50 / 0.30 / 0.12）。换成幂律后
  // 同样的 x 位置 R 值整体抬高，直接沿用旧值等于偷偷放宽了三档。这里按
  // 「x 不变、R 重新解」换算：指数 R=e^-x 反解 x，再代进幂律 (1+K·x)^-β。
  // 这样五个等级的**语义边界**（几天/几周/几个月）跨版本保持可比，
  // 历史记忆不会因为换公式而整体跳级。
  //   x=0.329 -> 0.568 | x=0.693 -> 0.429 | x=1.204 -> 0.339 | x=2.120 -> 0.263
  for (const g of graded) {
    if (g.R >= 0.568 && g.S >= 6)      g.level = 'L1';
    else if (g.R >= 0.429 && g.S >= 4) g.level = 'L2';
    else if (g.R >= 0.339)             g.level = 'L3';
    else if (g.R >= 0.263)             g.level = 'L4';
    else                               g.level = 'L5';
  }

  // ── 排序键：又强又新 ─────────────────────────────────────────────────
  // 单看 S 会让「很久以前连聊几小时」霸榜，单看 R 会让「刚才说了句废话」进核心。
  // 单看 S 会让「很久以前连聊几小时」霸榜，单看 R 会让「刚才说了句废话」进核心。
  // 再乘 (1 - suppress)：被别的提取压住的那批往后排（retrieval-induced forgetting）。
  // 再乘 schema：强图式的成员让位给抽象（细节不消失，只是排后面）。
  //
  // 三个乘数都**只进 rank，不进 level** —— 绝对阈值那道闸不认它们，所以被压的、
  // 被让位的仍在原来的等级里。做进 level 会让「搜过 A 之后 B 突然消失」或
  // 「沉淀成规则之后细节集体降级」，那是 bug 体验不是记忆。
  const SCHEMA_DEMOTE_AT = 4;         // S_line ≥ 4 视为成形（实测 2 件 56 条 = 4.88）
  const SCHEMA_DEMOTE_TO = 0.85;
  const rank = (g) => {
    const schema = (g.threadS || 0) >= SCHEMA_DEMOTE_AT ? SCHEMA_DEMOTE_TO : 1;
    return g.R * Math.log(1 + g.S) * (1 - (g.suppress || 0)) * schema;
  };

  // ── 第二道闸：相对配额 ───────────────────────────────────────────────
  // 纯绝对阈值有个结构性毛病：总量越大，够到阈值的事件越多，L1 从 19 涨到 20 再涨
  // 到 30，「核心」就不再是核心了；而注入预算（maxL1/maxL2/maxL3）是固定的，最终
  // 变成「谁 newest 谁进上下文」，历史被系统性挤掉。
  //
  // 真实记忆的「核心」是**相对的**：你记得最牢的那批永远是总量的一小撮，而不是
  // 「强度超过某个绝对值的全部」。所以再加一道按比例的闸，超出配额的部分降一级。
  // 这样无论历史攒到 20 天还是 200 天，分级分布都稳定，注入量不会随对话变长而膨胀。
  const total = graded.length;
  if (total > 0) {
    const quota = {
      L1: Math.max(3, Math.round(total * 0.10)),
      L2: Math.max(6, Math.round(total * 0.22)),
      L3: Math.max(6, Math.round(total * 0.25)),
    };
    const demote = (lv, lower) => {
      const list = graded.filter((g) => g.level === lv);
      if (list.length <= quota[lv]) return;
      const keep = new Set(
        list.slice().sort((a, b) => rank(b) - rank(a)).slice(0, quota[lv]).map((g) => g.idx),
      );
      for (const g of list) {
        if (keep.has(g.idx)) continue;
        g.level = lower;
        g.demoted = true;          // 报告里标出来：是配额降级，不是留存不足
      }
    };
    demote('L1', 'L2');
    demote('L2', 'L3');
    demote('L3', 'L4');
  }

  graded.sort((a, b) => a.startAt - b.startAt);
  return graded;
}

export const LEVEL_NAME = {
  L1: 'L1 核心', L2: 'L2 长期', L3: 'L3 活跃', L4: 'L4 衰退', L5: 'L5 归档',
};

/** 主题线段最多几行。apply() 的兼容通道与 schema 都用这个上限；renderForPrompt 自己
 * 也钳一次 —— 它是公开 API，直接调用（测试、外部脚本）时没有 schema 兜底。 */
export const MAX_THREADS_CAP = 20;

/** 生成注入用的精简文本：L1 给标题，L2/L3 各给一行 */
/**
 * 标题截断长度。0.15.0 从 42 收到 32 —— 每行省 10 字符，35 行就是 350 字符，
 * 而 32 个汉字足够认出「那件事是什么」。真正的细节在摘要里，不在这里。
 */
const TITLE_CHARS = 32;

export function renderForPrompt(graded, { maxL1 = 6, maxL2 = 8, maxL3 = 3, maxThreads = 2, maxOlder = 0, threads = null, now = Date.now() } = {}) {
  const by = (lv) => graded.filter((g) => g.level === lv);

  /**
   * 相对时间（0.4.2）
   *
   * 人回想事情用的是「昨天那个」「上周那个」，不是「11-14 那个」—— 绝对日期要
   * 先做一次心算才知道有多久。注入文本给相对时间，模型不需要算就能判断新旧。
   *
   * **按日历日算，不按小时差**：11-14 23:50 距现在只有两小时，但人说的是「昨天」，
   * 不是「今天」。早期的实现用 Math.floor(小时差/24) 得到 0，于是凌晨两点会看到
   * 「今天(11-14)」这种自相矛盾的输出。
   */
  const dayDiff = (ms) => {
    const a = new Date(ms);
    const b = new Date(now);
    const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((db - da) / 86400000);
  };
  const ago = (ms) => {
    const days = dayDiff(ms);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return `${days}天前`;
    if (days < 14) return '上周';
    if (days < 60) return `${Math.floor(days / 7)}周前`;
    return `${Math.floor(days / 30)}个月前`;
  };

  // 标题用事件首句（人话），主题词只做补充。
  // 之前用 topics 拼接，结果全是 7811/dock/catch 这种技术碎片，看不出是什么事。
  const line = (g) => {
    const d = new Date(g.startAt);
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const title = (g.head || '').replace(/[`*#|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 42);
    // ▸ = 还没着落（蔡加尼克）：这类事最该被提起，也最容易被回想起
    const flag = (g.openness || 0) >= 0.3 ? '▸' : '';
    // ~ = 记得模糊：confidence 低（留存差 + 没被提取过）。知道自己不确定，比假装确定有用 ——
    // 模型看到这个符号会去回查原文，而不是拿模糊的梗概当事实。
    //
    // 阈值 0.25 是量出来的，不是拍的：真实数据里 confidence = 0.6·R + 0.4·practice，
    // 0.35 会标掉 51/91（56%，L2 几乎全带 ~，符号就废了）；0.20 一个都不标（0%）；
    // 0.25 标 6/91（7%），正好落在「少数真正模糊的」。
    const fog = (g.confidence ?? 1) < 0.25 ? '~' : '';
    return `- ${flag}${fog}${ago(g.startAt)}(${md}) ${g.count}条　${title}`;
  };

  // 排序权重：未完成的事加权。人不是按「强度」回忆事情，而是按「还没解决」。
  const weight = (g) => g.S * (1 + 0.3 * Math.max(g.openness || 0, 0));
  const out = [];

  // ── 主题线（0.5.0）──────────────────────────────────────────────────
  // 人回想事情是按「那条线」而不是「哪天哪条」。这一段的作用是让模型一眼看出
  // 「最近在推进哪几件事」，而不是从下面 12 条事件里自己归纳 —— 归纳要么不做，
  // 要么每次都得重做，还容易归纳错。
  //
  // 放在最前面，且只占 3 行：它是「目录」，不是正文。具体的还在下面。
  const nThreads = Number.isFinite(maxThreads)
    ? Math.max(0, Math.min(MAX_THREADS_CAP, Math.floor(maxThreads)))
    : 0;
  if (nThreads > 0 && threads && threads.length) {
    const mdOf = (ms) => {
      const d = new Date(ms);
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const rows = threads.slice(0, nThreads).map((t) => {
      const span = mdOf(t.startAt) === mdOf(t.lastAt)
        ? mdOf(t.startAt)
        : `${mdOf(t.startAt)}→${ago(t.lastAt)}`;
      const state = (t.openness || 0) >= 0.15 ? '推进中' : '已收尾';
      const label = String(t.label || '').replace(/[`*#|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
      return `- ${label}｜${span}｜${t.members.length}件 ${t.items}条｜${state}`;
    });
    out.push('【主题线 · 在推进什么】', ...rows, '');
  }

  // 时间分层保底：不能按「取最后 N 个」，否则热闹的一天会把历史全挤掉
  // （实测 L1 111 条里今天占 104 条，注入时前 12 条全是今天的执行细节）。
  // 给三个时间桶各留保底名额，桶内按 S 竞争，剩余名额再跨桶抢。
  const DAY = 86400000;
  const layered = (pool, total, quota) => {
    if (total <= 0) return [];          // maxLx=0 要真的是一条都不给
    const b = { today: [], week: [], older: [] };
    for (const g of pool) {
      const age = (now - g.startAt) / DAY;
      (age < 1 ? b.today : age < 7 ? b.week : b.older).push(g);
    }
    // 桶内按 weight 排，不是按裸 S —— 0.4.2 把 weight（含未完成度）用在了 L2/L3 的
    // topBy 上，却漏了 L1 的时间桶，等于「同一套权重只应用了一半」：一条三天前还没
    // 着落的事，在桶内竞争时不会因为未完成而被提前，而它在 L2 里会。
    const byS = (arr) => arr.slice().sort((x, y) => weight(y) - weight(x));
    const out = [];
    // 配额从总预算里扣：桶里能拿的不能超过「还剩多少名额」，
    // 否则 maxL1=8 时三个桶照样各取 4 条，配了个寂寞。
    for (const k of ['today', 'week', 'older']) {
      const room = Math.max(total - out.length, 0);
      out.push(...byS(b[k]).slice(0, Math.min(quota[k] || 0, room)));
    }
    // 剩余名额跨桶按 S 竞争
    const got = new Set(out.map((g) => g.idx));
    const rest = byS(pool.filter((g) => !got.has(g.idx)));
    while (out.length < total && rest.length) out.push(rest.shift());
    return out.slice(0, total).sort((a, b2) => a.startAt - b2.startAt);   // 输出按时间排，读起来顺
  };

  const l1 = layered(by('L1'), maxL1, { today: 4, week: 4, older: 4 });
  // L2/L3 以前是 slice(-N) 纯取最新，等于「等级内也按时间排」，和 L1 的时间桶逻辑
  // 不一致：一条三天前但还没着落的事，会被今天一条收尾了的事挤掉。改成按 weight
  // 取前 N，输出再按时间排。
  const topBy = (pool, n) => {
    if (!(n > 0)) return [];               // maxLx=0 必须真的是一条都不给
    return pool.slice()
      .sort((a, b) => weight(b) - weight(a))
      .slice(0, n)
      .sort((a, b) => a.startAt - b.startAt);
  };
  const l2 = topBy(by('L2'), maxL2);
  const l3 = topBy(by('L3'), maxL3);
  if (l1.length) out.push('【L1 核心事件 · 常驻】', ...l1.map(line));
  if (l2.length) out.push('', '【L2 长期事件】', ...l2.map(line));
  if (l3.length) out.push('', '【L3 活跃事件 · 只留索引】', ...l3.map(line));

  // 历史补位：>7 天的桶里常常一个 L1 都没有 —— 那几天数据稀疏，S 天然够不到
  // 全局阈值，结果「早期历史」永远不注入。这里不限等级，直接按 S 取最靠前的几条，
  // 让两周前的关键事件有机会露出来（实测 older 桶 L1 库存为 0，全被卡在 L2/L3）。
  const DAY2 = 86400000;
  // 排序不能只看 S：10-25 那天 128 条 QQ 群闲聊，密度高 S 高，按 S 排全是「神人」
  // 「[图片]」这种。S 衡量的是「聊得多」，不是「值得记」。
  // 加两件事：聊天来源降权 + 技术性加权（英文词/十六进制/路径的每千字密度）。
  const technicality = (g) => {
    const txt = (g.texts || []).join(' ');
    const en = (txt.match(/[a-z][a-z0-9_]{3,}/gi) || []).length;
    const hex = (txt.match(/0x[0-9a-f]+/gi) || []).length;
    const path = (txt.match(/[a-z]:\\|\/[a-z0-9_.]+\//gi) || []).length;
    const per1k = (en + hex * 3 + path * 3) / Math.max(txt.length / 1000, 1);
    return Math.min(per1k / 30, 1);          // 归一到 0..1
  };
  const isChat = (g) => /\[QQ(私聊|群)?\]/.test((g.head || '') + (g.texts || []).join('').slice(0, 200));

  // 历史补位必须排除已经注入过的：以前没有这一步，
  // L3 里刚出现过的条目会在「更早 · 按 S 补位」里原样再来一遍，白占 4 行预算。
  const shown = new Set([...l1, ...l2, ...l3].map((g) => g.idx));
  const olderPool = graded
    .filter((g) => (now - g.startAt) / DAY2 >= 7 && !shown.has(g.idx))
    .map((g) => ({ g, w: g.S * (isChat(g) ? 0.25 : 1) * (1 + technicality(g)) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, Math.max(0, Math.floor(maxOlder)))
    .map((x) => x.g);
  if (olderPool.length) {
    out.push('', '【更早 · 按 S 补位（不限等级）】', ...olderPool.map(line));
  }

  return out.join('\n');
}
