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
  return events;
}

/** 给事件算强度与留存 */
export function gradeEvents(events, now = Date.now(), accessFn = null) {
  // IDF：词在多少事件里出现
  const df = new Map();
  for (const ev of events) for (const t of ev.toks) df.set(t, (df.get(t) || 0) + 1);
  const N = Math.max(events.length, 1);

  const graded = events.map((ev, idx) => {
    const n = ev.items.length;
    const spanDays = Math.max(1, Math.round((ev.lastAt - ev.startAt) / 86400000) + 1);
    const ageH = Math.max((now - ev.lastAt) / 3600000, 0);

    // 密度：条/小时，防止「一口气聊一百条」被当成超级大事
    const hours = Math.max((ev.lastAt - ev.startAt) / 3600000, 0.25);
    const density = Math.min(n / hours, 40);

    // 实证权重：这条路上的记忆被真正查过几次。查过就是投票，
    // 比单靠条数密度猜更可信。没查过则为 1，不奖不罚。
    const acc = accessFn ? accessFn(ev) : { n: 0, last: null };
    const accessBoost = 1 + 0.25 * Math.log(1 + (acc.n || 0));
    const S = Math.log(1 + n) * (1 + 0.35 * Math.log(1 + spanDays)) * (1 + density / 60) * accessBoost;
    const R = Math.exp(-ageH / (S * 24));

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
    // 只有「同一天 + 序号连续」才能用 a..b 表示。
    // 事件是按时间邻近聚的，可能跨天，硬拼首尾会得到 000289..000044 这种
    // 起止反了的范围（verify 的条数核对就是靠这个抓出来的）。
    const contiguous = (() => {
      if (ids.length <= 1) return ids.length === 1;
      const parse = (id) => /^m_(\d{8})_([0-9a-f]{6})$/.exec(id);
      const p0 = parse(ids[0]);
      if (!p0) return false;
      for (let i = 1; i < ids.length; i++) {
        const pi = parse(ids[i]);
        if (!pi || pi[1] !== p0[1]) return false;              // 跨天
        if (+pi[2] !== +parse(ids[i - 1])[2] + 1) return false; // 不连续
      }
      return true;
    })();
    const idRange = !ids.length ? ''
      : (ids.length === 1 || contiguous) ? `${ids[0]}..${ids[ids.length - 1]}`.replace(/^(m_\d{8}_[0-9a-f]{6})\.\.\1$/, '$1')
      : `${ids[0]} +${ids.length - 1}（不连续）`;
    // 稳定的机器可读键：日期 + 事件起始时分。摘要写它，raw 用它取精确 ID 数组。
    const sd = new Date(ev.startAt);
    const eventKey = `e_${dayOf(ev.startAt).replace(/-/g, '')}_${String(sd.getHours()).padStart(2, '0')}${String(sd.getMinutes()).padStart(2, '0')}`;
    return {
      idx, day: ev.day, startAt: ev.startAt, lastAt: ev.lastAt, eventKey,
      ids, idRange, idsContiguous: contiguous,
      accessCount: acc.n || 0, lastAccess: acc.last || null,
      count: n, spanDays, ageH: Math.round(ageH * 10) / 10,
      S: Math.round(S * 100) / 100,
      R: Math.round(R * 1000) / 1000,
      density: Math.round(density * 10) / 10,
      topics: scored,
      head: head.slice(0, 90),
      tail: tail.slice(0, 90),
    };
  });

  for (const g of graded) {
    if (g.R >= 0.72 && g.S >= 6)       g.level = 'L1';
    else if (g.R >= 0.5 && g.S >= 4)   g.level = 'L2';
    else if (g.R >= 0.3)               g.level = 'L3';
    else if (g.R >= 0.12)              g.level = 'L4';
    else                               g.level = 'L5';
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
