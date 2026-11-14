/**
 * 每日摘要生成器
 *
 * 目标：给每一天生成一份「事件级摘要」，作为完整流水与上下文索引之间的中间层。
 *
 * 三层结构：
 *   <记忆目录>/YYYY-MM-DD.md             完整流水（一字不删，永久）
 *   <DSH_HOME>/memory-notes/_digest/…    每日摘要（事件清单 + 首尾句 + 关键词）
 *   注入上下文                       只有日期索引 + 高留存事件标题
 *
 * 检索路径：上下文索引 → 某日摘要 → 该日完整流水
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEntries, clusterEvents, gradeEvents, LEVEL_NAME, EN_STOP, cleanLine } from './events.js';

const MAX_EVENTS_PER_DAY = 14;   // 一天最多列这么多事件，超出只报数量
const HEAD_CHARS = 60;
const TAIL_CHARS = 60;

const PAD = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
};
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
};

/** 取事件的首句（去掉 markdown 噪音，截断） */
function headLine(texts) {
  for (const t of texts || []) {
    for (const line of String(t).split('\n')) {
      const s = cleanLine(line);
      if (s) return s.slice(0, HEAD_CHARS);
    }
  }
  return '';
}

/** 取事件的末句（通常是结论） */
function tailLine(texts) {
  const arr = (texts || []).slice().reverse();
  for (const t of arr) {
    const lines = String(t).split('\n').reverse();
    for (const line of lines) {
      const s = cleanLine(line);
      if (s) return s.slice(0, TAIL_CHARS);
    }
  }
  return '';
}

/** 当天关键词：按「出现在几天」算 IDF，取最有辨识度的几个中文/英文词 */
function topKeywords(dayEvents, allEvents) {
  // 召回靠的是「摘要里有没有这个词」，不是「这个词重不重要」。
  // 所以这里分两档并放开数量：术语（英文/数字/十六进制/路径）宁可多列，
  // 也不能把 maxLifetime、fetchSize 这种用户真会问的词滤掉 —— 被 IDF 滤掉过一次。
  const N = Math.max(allEvents.length, 1);
  const toksOf = (ev) => ev.toks || new Set(ev.topics || []);
  const df = new Map();
  for (const ev of allEvents) for (const t of toksOf(ev)) df.set(t, (df.get(t) || 0) + 1);

  const term = new Map();   // 英文/数字/十六进制
  const han = new Map();    // 中文二元词

  for (const ev of dayEvents) {
    for (const t of toksOf(ev)) {
      if (t.length < 2) continue;
      if (EN_STOP.has(t)) continue;
      if (/^m_?\d{8}/.test(t)) continue;
      const idf = Math.log(N / (1 + (df.get(t) || 1)));
      const isTerm = /^[a-z0-9_.:/-]+$/.test(t);
      if (isTerm) {
        // 术语不看 IDF，只看出现频次：fetchSize 遍布多天但照样是关键线索
        term.set(t, (term.get(t) || 0) + 1);
      } else if (idf > 0.3) {
        han.set(t, (han.get(t) || 0) + idf * Math.min(t.length, 4));
      }
    }
  }

  const terms = [...term.entries()].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 24).map((x) => x[0]);
  const hans = [...han.entries()].sort((a, b) => b[1] - a[1])
    .slice(0, 12).map((x) => x[0]);

  // 全局术语层：某个术语今天出现 110 次、明天可能 0 次，只按当日生成就跨天召不回。
  // 累计全量频次取 top 24，跟当日术语一起写进摘要。
  const globalTerm = new Map();
  for (const ev of allEvents) {
    for (const t of toksOf(ev)) {
      if (t.length < 2 || EN_STOP.has(t)) continue;
      if (/^m_?\d{8}/.test(t)) continue;
      if (!/^[a-z0-9_.:/-]+$/.test(t)) continue;
      globalTerm.set(t, (globalTerm.get(t) || 0) + 1);
    }
  }
  const globalTerms = [...globalTerm.entries()].filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1]).slice(0, 24).map((x) => x[0])
    .filter((x) => !terms.includes(x));

  return { terms, hans, globalTerms };
}

/** 生成一天的摘要正文 */
function renderDay(day, dayEvents, allEvents) {
  const total = dayEvents.reduce((a, g) => a + g.count, 0);
  const cnt = { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 };
  for (const g of dayEvents) cnt[g.level] = (cnt[g.level] || 0) + 1;

  const out = [`# ${day} · ${total} 条 / ${dayEvents.length} 事件`, ''];
  out.push(`分级：L1 ${cnt.L1}　L2 ${cnt.L2}　L3 ${cnt.L3}　L4 ${cnt.L4}　L5 ${cnt.L5}`);

  const kw = topKeywords(dayEvents, allEvents);
  if (kw.terms.length) out.push(`术语：${kw.terms.join('、')}`);
  if (kw.globalTerms.length) out.push(`全局：${kw.globalTerms.join('、')}`);
  if (kw.hans.length) out.push(`主题：${kw.hans.join('、')}`);
  out.push('');

  const sorted = dayEvents.slice().sort((a, b) => a.startAt - b.startAt);
  const shown = sorted.slice(0, MAX_EVENTS_PER_DAY);
  for (const g of shown) {
    const span = g.startAt === g.lastAt ? hhmm(g.startAt) : `${hhmm(g.startAt)}–${hhmm(g.lastAt)}`;
    const topics = (g.topics || []).slice(0, 3).join(' · ') || '—';
    out.push(`## ${span}（${g.count}条 · ${g.level}）`);
    if (g.eventKey) out.push(`event: ${g.eventKey}`);
    // 权威是上面的 event: 键（指向 ids.json 的完整数组）。
    // 这里只给人看覆盖范围，不再用 `id:` 前缀 —— 两套写法并存会让工具
    // 误把范围当权威，之前范围 bug 就是这么来的。
    if (g.idRange) out.push(`覆盖: ${g.idRange}`);
    out.push(topics);
    const h = g.head && g.head.length >= 4 ? g.head.slice(0, HEAD_CHARS) : headLine(g.texts);
    const t = g.tail && g.tail.length >= 4 ? g.tail.slice(0, TAIL_CHARS) : tailLine(g.texts);
    const firstId = g.ids && g.ids.length ? g.ids[0] : '';
    const lastId = g.ids && g.ids.length ? g.ids[g.ids.length - 1] : '';
    if (h) out.push(`- 开头：${h}${firstId ? `　[${firstId}]` : ''}`);
    if (t && t !== h) out.push(`- 收尾：${t}${lastId && lastId !== firstId ? `　[${lastId}]` : ''}`);
    out.push('');
  }
  if (sorted.length > MAX_EVENTS_PER_DAY) {
    out.push(`（另有 ${sorted.length - MAX_EVENTS_PER_DAY} 个低权重事件未列出，需要时查完整流水）`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * 生成全部每日摘要。会写文件。
 *
 * @param {string} memDir     完整流水目录，**读**这里
 * @param {string} digestDir  摘要输出目录，**写**这里（`<DSH_HOME>/memory-notes/_digest`）
 * @returns {{ written: Array<{day: string, chars: number}>, total: number, events: number }}
 */
export function buildDailies(arg) {
  if (typeof arg === 'string') {
    throw new TypeError('buildDailies 的参数改成了对象形式：buildDailies({ memDir, digestDir })');
  }
  const { memDir, digestDir, days } = arg || {};
  const selectedDays = days ? new Set(days) : null;
  const entries = readEntries(memDir);
  if (!entries.length) return { written: [], total: 0 };

  const events = clusterEvents(entries);
  const graded = gradeEvents(events);

  // 补回 texts 与 toks（gradeEvents 只返回摘要字段，不含原文和词集）
  for (const g of graded) {
    const src = events[g.idx];
    g.texts = src?.texts || [];
    g.toks = src?.toks || new Set(g.topics || []);
    g.ids = src?.ids || [];
  }

  const byDay = new Map();
  for (const g of graded) {
    const day = dayOf(g.startAt);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(g);
  }

  mkdirSync(digestDir, { recursive: true });
  const written = [];
  for (const [day, list] of [...byDay].sort()) {
    if (selectedDays && !selectedDays.has(day)) continue;
    const body = renderDay(day, list, graded);
    writeFileSync(join(digestDir, `${day}.md`), body, 'utf8');
    // 机器可读旁挂：事件 -> 完整 ID 数组。
    // markdown 给人看（范围可能写成 +N 不连续），json 给工具取文用 ——
    // 少了这个，+N 事件的回查就是坏的（范围展开会拉进不属于该事件的 ID）。
    const map = {};
    for (const g of list) {
      const at = new Date(g.startAt);
      const key = `e_${day.replace(/-/g, '')}_${String(at.getHours()).padStart(2, '0')}${String(at.getMinutes()).padStart(2, '0')}`;
      map[key] = { ids: g.ids || [], count: g.count, level: g.level };
    }
    writeFileSync(join(digestDir, `${day}.ids.json`), JSON.stringify(map), 'utf8');
    written.push({ day, events: list.length, chars: body.length });
  }
  return { written, total: entries.length, events: graded.length };
}

/**
 * 读某天的摘要。
 *
 * @param {string} digestDir 摘要目录（`<DSH_HOME>/memory-notes/_digest`）。
 *   **不是**流水目录。传错只会返回 null，不会报错。
 * @param {string} day       日期，形如 `2026-11-11`
 * @returns {string|null}    摘要正文；文件不存在时 null
 */
export function readDigest(arg) {
  if (typeof arg === 'string') {
    throw new TypeError('readDigest 的参数改成了对象形式：readDigest({ digestDir, day })');
  }
  const { digestDir, day } = arg || {};
  const p = join(digestDir, `${day}.md`);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

/**
 * 列出所有可用的日期，取摘要目录与流水目录的并集。
 *
 * 两个参数都是目录，顺序是「流水在前、摘要在后」；任何一个传 null 就跳过那一侧。
 *
 * @param {string|null} memDir     完整流水目录
 * @param {string|null} digestDir  摘要目录
 * @returns {string[]} 升序排列的 `YYYY-MM-DD`
 */
export function listDays(arg) {
  if (typeof arg === 'string') {
    throw new TypeError('listDays 的参数改成了对象形式：listDays({ memDir, digestDir })');
  }
  const { memDir, digestDir } = arg || {};
  const set = new Set();
  for (const dir of [digestDir, memDir]) {
    if (!dir) continue;          // searchAll 只传 memDir，digestDir 可能为 null
    if (!existsSync(dir)) continue;
    for (const fn of readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(fn);
      if (m) set.add(m[1]);
    }
  }
  return [...set].sort();
}

/**
 * 某天完整流水里按关键词过滤条目（用于「按摘要反查原文」）。
 *
 * HEAD 必须容忍尾部锚点。流水现在每一行都写成
 *   2026-11-12 16:08 ［用户］ <!-- m_20261112_4f4be4 -->
 * 早先这个正则结尾是 `\s*$`，带锚点的行一条都匹配不上 —— total 恒为 0，
 * 而全库 1798 条又全都带锚点，等于这个通道整个是死的。
 *
 * pattern 走 makeMatcher：默认字面量，只有 /.../ 才当正则。
 * 以前这里是裸 new RegExp，同一个词在 memory_search 和 day+pattern 两条路
 * 语义不同（v2.8 在一边只匹配字面，在另一边 . 通配 v2x8 也算命中）。
 */
export function grepDay(arg) {
  if (typeof arg === 'string') {
    throw new TypeError('grepDay 的参数改成了对象形式：grepDay({ memDir, day, pattern, maxChars })');
  }
  const { memDir, day, pattern, maxChars = 4000 } = arg || {};
  const p = join(memDir, `${day}.md`);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  const HEAD = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+［(.+?)］(?:\s*<!--\s*(m_[0-9]{8}_[0-9a-f]{6})\s*-->)?\s*$/;
  const blocks = [];
  let cur = null;
  let seq = 0;
  for (const line of raw.split(/\r?\n/)) {
    const m = HEAD.exec(line);
    if (m) {
      if (cur) blocks.push(cur);
      // 与 readById / events.js readEntries 一致：兜底编号只给缺锚点的递增
      const anchored = m[4];
      if (!anchored) seq += 1;
      cur = {
        head: line,
        body: [],
        id: anchored || `m_${day.replace(/-/g, '')}_${String(seq).padStart(6, '0')}`,
      };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) blocks.push(cur);

  let hits = blocks;
  if (pattern) {
    const matcher = makeMatcher(pattern);
    hits = blocks.filter((b) => matcher.re.test(b.head) || matcher.re.test(b.body.join('\n')));
  }
  const out = [];
  let used = 0;
  for (let i = 0; i < hits.length; i++) {
    const b = hits[i];
    const txt = b.head + '\n' + b.body.join('\n').trim();
    if (used + txt.length > maxChars) {
      // 单条就超预算时退化为截断输出：只报「还有 N 条」而不给正文，
      // 调用方看到「命中 1 条」却读不到任何内容，等于白查。
      const room = maxChars - used;
      if (room >= 160) out.push(txt.slice(0, room) + `\n…（此条 ${txt.length} 字符，已截断；加大 maxChars 取全文）`);
      else out.push(`（命中 ${hits.length} 条，剩余 ${hits.length - i} 条超出 maxChars=${maxChars}；加大 maxChars 取值）`);
      break;
    }
    out.push(txt);
    used += txt.length;
  }
  return { total: hits.length, text: out.join('\n\n') };
}

/**
 * 按 memory_id 精确取一条原文（锚点回查的终点）。
 *
 * @param {string} memDir 完整流水目录
 * @param {string} id     `m_YYYYMMDD_<6位十六进制>`
 * @returns {{ id: string, day: string, text: string } | null}
 *   **是对象不是字符串**：`.text` 才是正文（首行含时间与说话人，后面是内容）
 */
export function readById(arg) {
  if (typeof arg === 'string') {
    throw new TypeError('readById 的参数改成了对象形式：readById({ memDir, id })');
  }
  const { memDir, id } = arg || {};
  const m = /^m_(\d{4})(\d{2})(\d{2})_([0-9a-f]{6})$/.exec(String(id || ''));
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const p = join(memDir, `${day}.md`);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  const HEAD = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+［(.+?)］(?:\s*<!--\s*(m_[0-9]{8}_[0-9a-f]{6})\s*-->)?\s*$/;
  const lines = raw.split(/\r?\n/);
  let cur = null;
  let seq = 0;
  const out = [];
  for (const line of lines) {
    const mm = HEAD.exec(line);
    if (mm) {
      if (cur) out.push(cur);
      // 兜底编号只给「缺锚点」的条目递增，与 events.js readEntries 保持一致。
      // 以前这里每行都 seq++，混合文件里同一条旧条目会在两处算出不同 id，
      // 表现为 readById 报「没有 id」。
      const anchored = mm[4];
      if (!anchored) seq += 1;
      cur = {
        head: line,
        body: [],
        id: anchored || `m_${day.replace(/-/g, '')}_${String(seq).padStart(6, '0')}`,
      };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) out.push(cur);
  const hit = out.find((b) => b.id === String(id));
  if (!hit) return null;
  return { id: hit.id, day, text: hit.head + '\n' + hit.body.join('\n').trim() };
}

/** 按 id 前缀或日期范围批量取（给「回查一段」用） */
export function readByIds(arg) {
  if (typeof arg === 'string') {
    throw new TypeError('readByIds 的参数改成了对象形式：readByIds({ memDir, ids, maxChars })');
  }
  const { memDir, ids, maxChars = 4000 } = arg || {};
  const res = [];
  let used = 0;
  let truncated = 0;
  for (const id of ids) {
    const one = readById({ memDir, id });
    if (!one) continue;
    if (used + one.text.length > maxChars) {
      // 保底：一条都还没塞进去时，至少给第一条的截断版。
      // 以前这里是裸 break，单条超过 maxChars 就 found=0，
      // 工具返回「共 N 条 / 本次只取到 0 条」，看起来像坏了。
      if (res.length === 0) {
        res.push(one.text.slice(0, Math.max(200, maxChars - 120))
          + `\n…（本条 ${one.text.length} 字符，已截断到 ${maxChars} 上限；加大 maxChars 取全文）`);
        truncated = 1;
        used = maxChars;
      }
      break;
    }
    res.push(one.text);
    used += one.text.length;
  }
  return {
    found: res.length,
    total: ids.length,
    truncated,
    text: res.join('\n\n'),
  };
}

/**
 * 全流水关键词搜索 —— 摘要召回的兜底通道。
 *
 * 为什么需要：摘要里的词是算法挑的，中文还走二元切词（「悬浮窗」会变成
 * 「悬浮」「浮窗」），用户问的三字词大概率命中不了。与其让摘要塞满所有词，
 * 不如直接搜流水原文，一次扫全部日期，返回 date + memory_id。
 *
 * 返回按日期倒序，每条带 id，方便继续用 readById 取全文。
 */

/**
 * 收集摘要里被引用过的 id，用于给命中加权。
 *
 * 注意：里面的 `m_a..m_b` 展开只对**旧格式**摘要有效 —— 哈希 id 之后
 * 摘要写的是「覆盖: m_xxx +N（不连续）」，那段正则匹配不到。保留是为了
 * 兼容历史摘要文件，新数据靠下面的全量 id 扫描兜住。
 */
function digestCited(digestDir) {
  const s = new Set();
  if (!digestDir || !existsSync(digestDir)) return s;
  for (const fn of readdirSync(digestDir)) {
    if (!fn.endsWith('.md')) continue;
    const t = readFileSync(join(digestDir, fn), 'utf8');
    for (const m of t.matchAll(/m_(\d{8})_([0-9a-f]{6})\.\.m_\d{8}_([0-9a-f]{6})/g)) {
      const from = +m[2], to = +m[3];
      for (let n = from; n <= to && n - from < 500; n++) {
        s.add(`m_${m[1]}_${String(n).padStart(6, '0')}`);
      }
    }
    for (const id of t.match(/m_[0-9]{8}_[0-9a-f]{6}/g) || []) s.add(id);
  }
  return s;
}

/**
 * pattern 语义：默认**字面量**，只有 /.../ 才当正则。
 *
 * 不定死会出事：搜 v2.8 时 `.` 匹配任意字符，v2x8 也算命中 —— 返回了结果，
 * 只是错的，而且很难察觉。宁可默认安全，显式 /.../ 才放开正则。
 */
export function makeMatcher(pattern) {
  const s = String(pattern ?? '').trim();
  if (s.length >= 2 && s.startsWith('/') && s.endsWith('/')) {
    try { return { re: new RegExp(s.slice(1, -1), 'i'), literal: false, src: s }; }
    catch { /* 正则写错就当字面量 */ }
  }
  const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { re: new RegExp(esc, 'i'), literal: true, src: s };
}

/**
 * 全流水关键词搜索。
 *
 * 打分（归一化后加权，不是裸乘）：
 *   hit   = min(1+log2(次数), 4) / 4    ← 命中次数是长尾，直接乘会把复述当相关
 *   cite  = 被摘要引用 ? 1 : 0
 *   （时间衰减已停用：数据跨度 21 天 < 半衰 90 天，fresh 恒在 0.82~1.0，无区分度。
 *    真实跨度超过 60 天再启用，权重从 hit/cite 里匀回来。）
 *   score = 0.62*hit + 0.38*cite
 *
 * 多词：默认 AND；无结果时**逐级放宽**（每次丢掉当日命中最少的那个词），
 * 不是一步退到 OR —— 全 OR 等于把 query 拆散。
 */
export function searchAll(arg) {
  if (typeof arg === 'string') {
    throw new TypeError('searchAll 的参数改成了对象形式：searchAll({ memDir, pattern, maxHits, digestDir })');
  }
  const { memDir, pattern, ...opts } = arg || {};
  const maxHits = typeof opts.maxHits === 'number' ? opts.maxHits : 10;
  const win = typeof opts.window === 'number' ? opts.window : 130;
  const digestDir = opts.digestDir || null;
  const stateMap = opts.stateMap || null;   // memoryId -> 'active'|'cold'|'archived'

  // 疑问助词/语气词从查询里剔除。
  // 实测：「write refused 怎么定的」被拆成 3 个词要求全命中，结果只剩 3 条，
  // 期望的那条原始日志（只有 write refused，没有「怎么定的」）根本不进池子。
  // 检索靠实词，疑问词只会把结果钉死。
  const Q_STOP = /^(怎么|如何|为什么|为啥|什么|哪里|哪个|哪些|多少|是否|有没有|是不是|能不能|可不可以|的|了|吗|呢|吧|啊|呀|嘛|哦|哈|怎样|怎么样|怎么回事|怎么办|怎么定|怎么弄|怎么搞)+$/;
  const raw = String(pattern || '').trim().split(/\s+/).filter(Boolean);
  const terms = raw.filter((w) => !Q_STOP.test(w));
  // 全是疑问词时退回原文，不然搜了个寂寞
  const use0 = terms.length ? terms : raw;
  if (!use0.length) return { hits: [], total: 0, mode: 'none', relaxed: 0 };
  const cited = digestCited(digestDir);

  const days = listDays({ memDir, digestDir }).slice().reverse();
  const blocks = [];
  const HEAD = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+［(.+?)］(?:\s*<!--\s*(m_[0-9]{8}_[0-9a-f]{6})\s*-->)?\s*$/;

  for (const day of days) {
    const p2 = join(memDir, `${day}.md`);
    if (!existsSync(p2)) continue;
    const raw = readFileSync(p2, 'utf8');
    let cur = null;
    let seq = 0;
    for (const line of raw.split(/\r?\n/)) {
      const mm = HEAD.exec(line);
      if (mm) {
        if (cur) blocks.push(cur);
        // 同上：只给缺锚点的条目递增
        const anchored = mm[4];
        if (!anchored) seq += 1;
        cur = {
          id: anchored || `m_${day.replace(/-/g, '')}_${String(seq).padStart(6, '0')}`,
          day, time: mm[2], body: [],
        };
      } else if (cur) cur.body.push(line);
    }
    if (cur) blocks.push(cur);
  }

  // 每个 block 预先算「包含哪些词、各几次」
  const bag = blocks.map((b) => {
    const text = b.body.join('\n');
    const cnt = new Map();
    for (const w of use0) {
      const { re } = makeMatcher(w);
      const ms = text.match(new RegExp(re.source, 'gi'));
      cnt.set(w, ms ? ms.length : 0);
    }
    return { b, text, cnt };
  });

  // 召回改成「加权 OR」而不是 AND。
  //
  // 为什么：AND 要求所有词都命中，正确答案往往只含其中一部分 ——
  // 实测 5 条历史 query 里有 5 条期望条根本不进池子（「缓存 失效 排查」
  // 要求三个词全中，而真正的排查记录只说「缓存失效」没说「排查」）。
  // AND 的结果是「查得越具体越查不到」，和检索直觉相反。
  //
  // 新做法：含任一词就进池，然后用 coverage（命中词数占比）加权 ——
  // 全命中的仍然排前面，但只命中关键词的也有机会。
  const use = use0.slice();
  const hitBag = bag.filter((x) => use.some((w) => x.cnt.get(w) > 0));
  const mode = 'OR-WEIGHTED';
  const relaxed = 0;
  if (!hitBag.length) return { hits: [], total: 0, mode: 'none', relaxed };

  // 元描述降权：压缩摘要 / 技术报告这类整段复述里塞满了所有关键词，
  // 命中次数天然高，会把原始记录挤下去（实测「缓存」「超时」「重试」
  // 的 top1 全是压缩摘要那种整段复述）。
  // 它们不是证据，是证据的转述 —— 降到原始记录之后。
  const isMeta = (text) => {
    const head = text.slice(0, 220);
    if (/^<analysis>|^让我按时间顺序|^structural summary|^Established context|^This visible span|^\*\*Message \d+/i.test(head)) return true;
    if (text.length > 1500 && /compacted context|Message \d+ \(user\)|chronologically|compacted-summary|Established context/i.test(text)) return true;
    return false;
  };

  // 元讨论检测：正文里出现**别的** memory_id，说明这条在「讨论另一条记录」，
  // 而不是在陈述事实。实测：「write refused 怎么定的」返回的是我刚讨论
  // 「这问题怎么查」的记录，而不是 11-09 那行原始日志 —— 元讨论更新、更长、
  // 命中更多，而 isMeta 只认固定格式（<analysis>/compacted context）认不出它。
  //
  // 原始流水里 id 只出现在行尾注释，正文出现 id = 一定在引用记忆内容。
  const refsOther = (text, selfId) => {
    const ids = text.match(/m_\d{8}_[0-9a-f]{6}/g);
    if (!ids) return false;
    return ids.some((id) => id !== selfId);
  };

  // 状态权重：遗忘是降权不是隐藏。archived 仍能被搜到，只是排后面
  // （索引里写着「冷和档都要查」，如果直接过滤掉就自相矛盾了）。
  const STATE_W = { active: 1, cold: 0.7, archived: 0.4 };
  const stateOfId = (id) => (stateMap && stateMap.get(id)) || 'active';

  const scored = hitBag.map((x) => {
    const total = use.reduce((a, w) => a + (x.cnt.get(w) || 0), 0);
    const matched = use.filter((w) => x.cnt.get(w) > 0).length;
    // coverage 是主信号：命中几个词 / 一共几个词。只命中四分之一的，
    // 分数上限就是 0.25，不可能挤掉全命中的条目。
    const coverage = use.length ? matched / use.length : 0;
    const hitScore = coverage * (Math.min(1 + Math.log2(Math.max(total, 1)), 4) / 4);
    const citeScore = cited.has(x.b.id) ? 1 : 0;
    let score = 0.62 * hitScore + 0.38 * citeScore;
    // 转述让位于原始证据，但「结论类」摘要例外 ——
    // v29 SUCCESS 这种既像摘要又是最终答案，压下去等于把定稿藏了。
    // 结论类只「抵消降权」不额外加分：score ∈ [0,1]，+0.4 等于抬升 40%，
    // 会把「最终没搞定」这种也顶到最前，正好是元描述压过原始的另一种形态。
    // 而且判据是纯字符串匹配，「最终/搞定」误判率高，只给它免除 0.55 的惩罚就够了。
    const isConclusion = /v\d+\s*SUCCESS|最终|定稿|结论[:：]|搞定了|已完成|delivered|SOLVED/i.test(x.text.slice(0, 800));
    if (isMeta(x.text) && !isConclusion) score *= 0.55;

    // 引用他条 = 元讨论，让位给原始证据。结论类除外（结论本身就会引用前文）。
    if (!isConclusion && refsOther(x.text, x.b.id)) score *= 0.45;

    score *= STATE_W[stateOfId(x.b.id)] || 1;
    return { ...x, total, score };
  });

  // 同分时按 id 升序 —— 否则并列条目的顺序取决于数组顺序，
  // 实测「悬浮球 不显示」的期望条和 top10 最后一名差 0.000 分，被随机挤掉。
  // 同分时按「时间升序」而非 id —— hash id 是随机的，拿它 tiebreak 等于随机排。
  // 按时间排的语义是「同样相关时，先发生的先看到」，至少是可解释的。
  scored.sort((a, b) => b.score - a.score
    || a.b.day.localeCompare(b.b.day)
    || a.b.time.localeCompare(b.b.time));
  const totalHits = scored.length;

  // 同主题归并：必须区分「复述」和「演化」，否则会把最后一次修正藏起来。
  //   · 前 120 字符去掉空白后完全相同   → 复述，保留**最早**（原始证据更可信）
  //   · 前 40 字符相同、但数字/版本/修正词不同 → 演化，保留**最新**（修正版才是答案）
  //   · 其余 → 并列，两条都留
  const numSet = (s) => new Set(String(s).match(/\d+(?:\.\d+)*|0x[0-9a-f]+/gi) || []);
  const FIXWORD = /改成|改为|不对|应该是|最终|最后|其实|纠正|修正|撤回|重来|换一种|不再/;
  const headKey = (s, n) => s.text.slice(0, n).replace(/\s+/g, '').replace(/[`*#|]/g, '');
  const earlier = (a, b) => (a.b.day < b.b.day) || (a.b.day === b.b.day && a.b.time < b.b.time);

  const groups = new Map();
  for (const s of scored.slice(0, maxHits * 4)) {
    // 同一天内的相似句是连续记录（「游戏进入主城」连说三遍），不是复述。
    // 复述的典型形态是「今天重复昨天说过的话」，所以只有跨天才归组。
    const k = headKey(s, 120) + '@' + s.b.day;
    const g = groups.get(k);
    if (!g) { groups.set(k, s); continue; }
    // 完全同文 → 留最早
    const win = earlier(s, g) ? s : g;
    win.earlierScore = Math.max(s.score, g.score, win.earlierScore || 0);
    groups.set(k, win);
  }

  // 演化归并：前 40 字符相同但关键信息不同的，当成同一主题的不同版本
  const list = [...groups.values()];
  const byPrefix = new Map();
  for (const s of list) {
    const pk = headKey(s, 40) + '@' + s.b.day;   // 同理，演化检测也不跨天合并
    if (!byPrefix.has(pk)) byPrefix.set(pk, []);
    byPrefix.get(pk).push(s);
  }
  const resolved = [];
  for (const arr of byPrefix.values()) {
    if (arr.length === 1) { resolved.push(arr[0]); continue; }
    // 有没有演化迹象
    const nums = arr.map((s) => numSet(s.text));
    const evolved = arr.some((s, i) => {
      if (FIXWORD.test(s.text.slice(0, 200))) return true;
      for (let j = 0; j < arr.length; j++) {
        if (i === j) continue;
        for (const x of nums[i]) if (!nums[j].has(x)) return true;
      }
      return false;
    });
    if (!evolved) { resolved.push(arr[0]); continue; }
    // 演化：取最新那条，旧的记 superseded 线索
    const latest = arr.slice().sort((a, b) => (earlier(a, b) ? 1 : -1))[0];
    latest.supersedes = arr.filter((x) => x !== latest).map((x) => x.b.id);
    latest.supersedeBoost = 0.6;   // 修正版本身值得靠前
    resolved.push(latest);
  }
  for (const s of resolved) {
    if (s.earlierScore) s.score = Math.max(s.score, s.earlierScore);
    if (s.supersedeBoost) s.score += s.supersedeBoost;
  }

  const pooled = resolved.sort((a, b) => b.score - a.score);

  const picked = pooled.slice(0, maxHits).sort((a, b) =>
    a.b.day === b.b.day ? a.b.time.localeCompare(b.b.time) : a.b.day.localeCompare(b.b.day));

  const hits = [];
  for (const s of picked) {
    const { re } = makeMatcher(use[0]);
    const at = s.text.search(re);
    const from = Math.max((at < 0 ? 0 : at) - win, 0);
    const snippet = s.text.slice(from, from + win * 2).replace(/\s+/g, ' ').trim();
    hits.push({ id: s.b.id, ids: [s.b.id], day: s.b.day, time: s.b.time, snippet, merged: 0, score: +s.score.toFixed(3) });
  }

  return { hits, total: totalHits, mode, relaxed, usedTerms: use };
}

/**
 * 展开 id 区间 `"m_a..m_b"`。
 *
 * 只接**内容哈希 id 的区间**。因为哈希是随机的，无法推算中间项，所以实现上
 * 是把整份流水读一遍、筛出落在两天之间的 id，不是算术展开。
 *
 * 事件键（`e_YYYYMMDD_NNNN`）**不能**传这里，那种要用 `eventIds()`。
 *
 * @param {string} spec 形如 `"m_20260115_a1b2c3..m_20260120_d4e5f6"`
 * @returns {string[]} 区间内的 id，按出现顺序；格式不对返回空数组
 */
export function expandRange(spec) {
  const s = String(spec || '').trim();
  const m = /^(m_\d{8}_[0-9a-f]{6})\.\.(m_\d{8}_[0-9a-f]{6})$/.exec(s);
  if (m) {
    const [, a, b] = m;
    // 内容哈希 id 不能展开。以前 id 是递增序号，a..b 能推算出中间每一项；
    // 哈希是随机的，+"d64bb6" 得到 NaN，循环一次都不跑 —— 结果返回空数组，
    // 表现为「范围内没命中（检查 0 条）」，看起来像没数据，其实是静默失败。
    //
    // 只返回两个端点（至少能取到首尾），真正的完整取文请用 event: 键
    // （摘要里 `覆盖:` 那行在有哈希 id 后已经一律写成 `+N（不连续）`）。
    return a === b ? [a] : [a, b];
  }
  const one = /^(m_\d{8}_[0-9a-f]{6})$/.exec(s);
  if (one) return [one[1]];
  return [];
}

/**
 * 把事件键展开成 id 列表。事件键来自 `gradeEvents()` 返回的 `eventKey` 字段
 * （形如 `e_20261020_1518`），数据源是摘要目录里的 `YYYY-MM-DD.ids.json`。
 *
 * 注意 `expandRange()` 只接 `m_a..m_b` 这种 id 区间，**接不了事件键** —— 事件键
 * 走这个函数。
 *
 * @param {string} digestDir 摘要目录（`<DSH_HOME>/memory-notes/_digest`），不是流水目录
 * @param {string} eventKey  事件键，形如 `e_20261020_1518`
 * @returns {{ ids: string[], count: number, level: string, day: string } | null}
 *   键格式不对、当天没有 ids.json、或键不在这份索引里时返回 null
 */
export function eventIds(arg) {
  if (typeof arg === 'string') {
    throw new TypeError('eventIds 的参数改成了对象形式：eventIds({ digestDir, eventKey })');
  }
  const { digestDir, eventKey } = arg || {};
  const m = /^e_(\d{4})(\d{2})(\d{2})_\d{4}$/.exec(String(eventKey || ''));
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const p = join(digestDir, `${day}.ids.json`);
  if (!existsSync(p)) return null;
  try {
    const map = JSON.parse(readFileSync(p, 'utf8'));
    const hit = map[eventKey];
    return hit ? { ids: hit.ids || [], count: hit.count, level: hit.level, day } : null;
  } catch {
    return null;
  }
}
