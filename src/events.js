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
 *   2. 相邻条目：时间间隔 ≤ GAP_MIN 且共享关键词 → 归入同一事件
 *   3. 事件强度 S = ln(1+条数) × (1 + 0.35·ln(1+跨度天数)) × (1 + 密度加成)
 *   4. 留存 R = exp(−距今小时 ÷ (S × 24))
 *   5. 分级 L1/L2/L3/L4/L5
 *
 * 注入只给 L1+L2（+部分 L3）的梗概，完整内容永远留在记忆目录里。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
  { re: /失败|报错|崩|挂掉|死机|超时|无响应|报错|异常|exception|error|failed|crash|broken/gi, w: 1.0 },
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
  const raw = events.map((ev) => signalDensity(ev));
  const sorted = raw.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  const p50 = at(0.5);
  const p90 = at(0.9);
  const span = p90 - p50;
  for (let i = 0; i < events.length; i++) {
    const d = raw[i];
    let m = 1;
    if (span > 1e-9 && d > p50) {
      const t = (d - p50) / span;                       // p50→1, p90→1 满格起点
      m = d <= p90 ? 1 + 0.15 * t : 1.15 + 0.20 * Math.min(t - 1, 1);
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
  // 纯英文长句基本是模型的过程叙述/元描述，不是内容
  if (!/[\u4e00-\u9fa5]/.test(s) && s.length > 50 && /\s/.test(s)) return '';
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

export function readEntries(memDir) {
  const out = [];
  if (!existsSync(memDir)) return out;
  for (const fn of readdirSync(memDir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(fn);
    if (!m) continue;
    const day = m[1];
    let raw;
    try { raw = readFileSync(join(memDir, fn), 'utf8'); } catch { continue; }
    let cur = null;
    for (const line of raw.split(/\r?\n/)) {
      if (/^<!-- dsh-note:auto-(?:begin|end):7f3a -->$/.test(line)) {
        if (cur) { out.push(cur); cur = null; }
        continue;
      }
      const mm = DAY_RE.exec(line);
      if (mm) {
        if (cur) out.push(cur);
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
    if (cur) out.push(cur);
  }
  const seqByDay = new Map();
  for (const e of out) {
    e.text = e.buf.join('\n').trim();
    if (!e.id) {
      const n = (seqByDay.get(e.day) || 0) + 1;
      seqByDay.set(e.day, n);
      e.id = `m_${e.day.replace(/-/g, '')}_${String(n).padStart(6, '0')}`;
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 把条目聚成事件 */
export function clusterEvents(entries) {
  const events = [];
  let cur = null;
  for (const e of entries) {
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
      };
      events.push(cur);
    }
    cur.lastAt = e.at;
    cur.day = e.day;
    cur.items.push(e);
    cur.texts.push(e.text);
    if (e.id) cur.ids.push(e.id);
    for (const t of toks) {
      if (cur.toks.size > 800) break;
      cur.toks.add(t);
    }
  }
  // 情绪显著度只依赖事件文本，与 now 无关 —— 在这里算一次随事件缓存，
  // 后续每次 gradeEvents 直接读，不重复扫文本。
  // 归一必须在全体事件层面做（相对归一），所以放在循环之后批量算。
  salienceAll(events);
  return events;
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
    const acc = accessFn ? accessFn(ev) : { n: 0, last: null, ts: [] };
    // 提取强度：边际递减 —— 第 1 次提取的巩固价值远大于第 20 次。
    const retrieval = 1 + 0.18 * Math.log(1 + (acc.n || 0));

    // 间隔效应：分散提取 > 集中重复（见 spacingOf）
    const spacing = spacingOf(acc.ts, now);

    // 情绪显著度：cluster 阶段已算好，与 now 无关
    const salience = ev.salience || 1;

    const S = Math.log(1 + n)
      * (1 + 0.35 * Math.log(1 + spanDays))
      * (1 + density / 60)
      * retrieval * spacing * salience;

    // 再巩固（reconsolidation）：衰减起点取「最近一次活动」与「最近一次被提取」中
    // 更晚的那个。真实记忆每被想起一次就重新固化一次，遗忘曲线从那一刻重新起算；
    // 只把提取加成塞进 S、却仍从原始时间点起算衰减，等于把「复习」当成了「内容更多」，
    // 结果一条被反复查阅的关键记忆照样会掉到 L5。这是 0.4.0 修正的核心偏差。
    const accessAt = acc.last ? new Date(acc.last).getTime() : 0;
    const anchor = Math.max(ev.lastAt, Number.isFinite(accessAt) ? accessAt : 0);
    const ageH = Math.max((now - anchor) / 3600000, 0);

    // 幂律遗忘
    const R = Math.pow(1 + POWER_K * (ageH / (S * 24)), -POWER_BETA);

    // 主题词：取事件里 IDF 最高的几个（IDF 高 = 不常见 = 有辨识度）
    const scored = [...ev.toks]
      .map((t) => ({ t, idf: Math.log(N / (1 + (df.get(t) || 1))), len: t.length }))
      .filter((x) => x.idf > 0.3 && x.t.length >= 2 && !EN_STOP.has(x.t))
      // 纯数字型碎片（7811 / 0x1c / 113mb）不是主题，留着只会挤掉真词
      .filter((x) => !/^(0x)?[0-9a-f]{2,}$/i.test(x.t) && !/^\d+[a-z]{1,3}$/i.test(x.t))
      .sort((a, b) => b.idf * Math.min(b.len, 4) - a.idf * Math.min(a.len, 4))
      .slice(0, 6)
      .map((x) => x.t);

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
    // 排序键：又强又新。单看 S 会让「很久以前连聊几小时」霸榜，
    // 单看 R 会让「刚才说了句废话」进核心。
    const rank = (g) => g.R * Math.log(1 + g.S);
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

/** 生成注入用的精简文本：L1 给标题，L2/L3 各给一行 */
export function renderForPrompt(graded, { maxL1 = 12, maxL2 = 20, maxL3 = 8, now = Date.now() } = {}) {
  const by = (lv) => graded.filter((g) => g.level === lv);
  // 标题用事件首句（人话），主题词只做补充。
  // 之前用 topics 拼接，结果全是 7811/dock/catch 这种技术碎片，看不出是什么事。
  const line = (g) => {
    const d = new Date(g.startAt);
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const title = (g.head || '').replace(/[`*#|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 42);
    return `- ${md} ${g.count}条　${title}`;
  };
  const out = [];
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
    const byS = (arr) => arr.slice().sort((x, y) => y.S - x.S);
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
  // slice(-0) 等价 slice(0)，会把全部返回 —— maxL2=0 必须真的是一条都不给
  const l2 = maxL2 > 0 ? by('L2').slice(-maxL2) : [];
  const l3 = maxL3 > 0 ? by('L3').slice(-maxL3) : [];
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

  const olderPool = graded
    .filter((g) => (now - g.startAt) / DAY2 >= 7)
    .map((g) => ({ g, w: g.S * (isChat(g) ? 0.25 : 1) * (1 + technicality(g)) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 4)
    .map((x) => x.g);
  if (olderPool.length) {
    out.push('', '【更早 · 按 S 补位（不限等级）】', ...olderPool.map(line));
  }

  return out.join('\n');
}
