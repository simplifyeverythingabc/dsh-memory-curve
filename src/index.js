/**
 * dsh-memory-curve —— 按遗忘曲线给记忆事件分级 + 每日摘要 + 原文反查
 *
 * 三层结构：
 *   <记忆目录>/YYYY-MM-DD.md             完整流水（一字不删，目录可配）
 *   <DSH_HOME>/memory-notes/_digest/…    每日摘要（事件清单 + 首尾句 + 关键词）
 *   注入上下文                       日期索引 + 高留存事件标题
 *
 * 检索顺序（照用户定的来）：
 *   上下文里看到线索 → memory_curve_day 读那天的摘要
 *   → 摘要里定位到具体事件 → memory_curve_raw 用关键词回原文
 *
 * 分级依据（艾宾浩斯）：
 *   强度 S = ln(1+条数) × (1 + 0.35·ln(1+跨度天数)) × (1 + 密度/60)
 *   留存 R = exp(−距今小时 ÷ (S × 24))
 *   L1 R≥0.72 且 S≥6　L2 R≥0.5 且 S≥4　L3 R≥0.3　L4 R≥0.12　L5 其余
 *
 * 「遗忘」的动作：L4/L5 不进上下文，但文件照旧留着，需要时按上面那条链去翻。
 */
import { existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/**
 * schemastery 是 DSH 自带的包，宿主环境里必有。
 *
 * 必须静态 import。曾经试过顶层 await 做可选导入，结果 Loader 读到模块时
 * `Config` 还是 undefined（异步赋值没跑完），Host 就不投影 namespace，
 * 配置编辑器永远显示 status=unavailable / revision=undefined。
 *
 * 代价：仓库目录 / CI 里没有这个包时模块加载会失败 —— CI 里造个 stub 顶上。
 */
import z from '@deepseek-ai/schemastery';
import { readEntries, clusterEvents, gradeEvents, renderForPrompt, LEVEL_NAME } from './events.js';
import { resolveMemDir, dshHome, normalizeDir } from './paths.js';
import { buildDailies, readDigest, listDays, grepDay, readById, readByIds, searchAll, expandRange, eventIds, makeMatcher } from './digest.js';
import { touch, sumAccess, stateOf, STATE_LABEL } from './access.js';
import { mountAutoCollector, writeAtomic } from './collector.js';

export const name = 'memory-curve';

export const inject = ['systemPrompt', 'tools'];

/**
 * 插件配置。DSH 的配置系统读的就是这个 schema，`cordis.patch.yml` 里写的
 * `config` 会按它校验和补默认值。
 *
 * 值和 web-search 等现有插件一致：静态 import schemastery（它是 profile 的
 * 依赖，能正常解析）+ z.object(...)。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 关于 token：这个插件每步都在花 token，装之前先看清这一节。
 *
 * DSH 每次调用模型都会重新组装系统提示。插件注册的 memory-curve-index 属于
 * runtime context，于是**每一个 step 都会带一份记忆索引**。一个 step 指一次
 * 模型调用——你发一句话算一个 step；我调一次工具、再回来继续，又是一个 step。
 * 所以同一轮对话里连着改八个文件，就是八份索引。
 *
 * 默认配置下一次注入约 2785 字符（实测，145 事件 / 2825 条流水），折合
 * 1500–2000 token，具体看各家的分词。数据越多越长，因为「最近几天」和
 * 「更早按 S 补位」是按事件条数截断的，不是按字符截断。
 *
 * 三档可调，改 profile 的 cordis.patch.yml，不要改这里的默认值：
 *
 *   档位一 · 默认，信息最全
 *     （什么都不用写，就用下面的 defaults）
 *
 *   档位二 · 精简，约省一半
 *     maxL1: 6
 *     maxL2: 10
 *     maxL3: 0
 *
 *   档位三 · 完全关闭注入，token 归零
 *     injectContext: false
 *     六个 memory_curve_* 工具照常可用，需要查记忆时现查。代价是模型不会
 *     自动知道有哪些记忆，得靠对话里提一句、或者主动去翻。
 *
 * 写进 patch 的样子：
 *
 *   - id: memory-curve
 *     name: dsh-memory-curve
 *     config:
 *       injectContext: false
 *
 * 另外三条和 token 有关的实情：
 *   · 注入的文本内容变了才会重算；插件内部有 3 秒短周期缓存，连续几次工具
 *     调用不会重复计算（实测 27ms → 0.001ms）。但这只省 CPU，不省 token，
 *     因为快照本身就每步生成一份。
 *   · 日志里那行「上下文注入 · runtime-context」是宿主 agent-loop 每步打
 *     的运行时快照，不是本插件单独触发，记忆索引只是拼在里面的一段。
 *   · maxL4 / maxL5 不存在，L4、L5 从来不注入，只存磁盘。
 * ─────────────────────────────────────────────────────────────────────
 */
export const Config = z.object({
  disabled: z
    .boolean()
    .default(false)
    .description('设 true 时 apply() 直接返回：不注册任何工具，也不注入上下文。用于临时停用而不卸载。'),
  memoryDir: z
    .string()
    .default('')
    .description(
      '完整记忆存放目录。填了就用它（不存在会自动创建），支持 %USERPROFILE%\\memory、~/memory、D:/memory 这几种写法；留空则回退到 DSH_MEMORY_DIR 环境变量，再不行用 <DSH_HOME>/memory。',
    )
    .volatile(),
  maxL1: z.number().min(0).max(200).default(12).description('L1 事件最多列几条，控制注入体积。'),
  injectContext: z
    .boolean()
    .default(true)
    .description('是否把记忆索引注入系统提示。设 false 后索引不再占每步 token，六个 memory_curve_* 工具照常可用，按需现查。'),
  maxL2: z.number().min(0).max(200).default(20).description('L2 事件最多列几条。'),
  maxL3: z.number().min(0).max(200).default(8).description('L3 事件最多列几条。'),
  autoCollect: z.boolean().default(false).description('启用会话消息自动采集、启动补漏和摘要刷新；只保存用户与助手正文。'),
  collectSubagents: z.boolean().default(false).description('自动采集是否包含子代理；默认排除，不影响已有流水。'),
  collectExcludeCwds: z.string().default('').description('排除的工作目录，换行或分号分隔，包含其子目录。'),
  collectExcludeSessions: z.string().default('').description('排除的会话 ID，换行或分号分隔。'),
  collectFlushMs: z.number().min(100).max(60000).default(1500).description('消息批量落盘间隔（毫秒）。'),
  collectScanMs: z.number().min(1000).max(3600000).default(60000).description('日志增量补漏间隔（毫秒）；启动时也会补漏。'),
  collectSummaryMs: z.number().min(100).max(60000).default(5000).description('有变动时摘要合并刷新间隔（毫秒）。'),
});


/**
 * context 的插值开关。必须是 false —— 见注册处的注释。
 * 提成常量是为了让启动日志能回读真实值，而不是打印一句拍脑袋的"已设置"。
 */
const CONTEXT_INTERPOLATE = false;

/** apply() 时存下来的 config，供模块级函数读取。 */
let liveConfig = null;

/**
 * 读一个配置字段。
 *
 * `.volatile()` 字段由 Loader 包成 live 引用（`{ get() }`）交给插件，
 * 不是裸值 —— { get() } 只可能来自 Loader 的 volatile 包装，或根本不出现。
 * 所以每次都得解引用，不能缓存成字符串。
 */
function readField(field, fallback) {
  const value = field && typeof field.get === 'function' ? field.get() : field;
  return value === undefined ? fallback : value;
}

function configuredMemDir() {
  return normalizeDir(readField(liveConfig?.memoryDir, ''));
}

/** 上一次确认过的目录。同一路径只 stat 一次，避免每个工具调用都走文件系统。 */
let lastEnsuredDir = null;

/** 只在「用户显式配置了路径」时创建它。
 *  没配置就不创建 —— 插件不该在你磁盘上悄悄留东西。
 *
 *  带缓存：同一路径只处理一次。如果 Loader 把 memoryDir 包成 live 引用，路径变了
 *  这里会重新处理一遍。 */
const ensureConfiguredDir = () => {
  const dir = configuredMemDir();
  if (!dir) { lastEnsuredDir = null; return; }
  if (dir === lastEnsuredDir) return;
  lastEnsuredDir = dir;
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      console.log(`[memory-curve] 已创建记忆目录：${dir}`);
    }
  } catch (err) {
    lastEnsuredDir = null;          // 失败了下轮再试
    console.warn(`[memory-curve] 无法创建记忆目录 ${dir}：${err?.message ?? err}`);
  }
};

/** 记忆流水目录。按优先级回退：
 *    1. Config 里的 memoryDir（cordis.patch.yml 配的，优先级最高）
 *    2. DSH_MEMORY_DIR        —— 环境变量
 *    3. MEMORY_GALAXY_DIR     —— 早期从 dsh-memory-galaxy 借用的，保留兼容
 *    4. D:\memory             —— Windows 老用户的历史位置，存在就用
 *    5. <DSH_HOME>/memory     —— 跨平台默认值
 *
 * 4/5 两条的判定在 src/paths.js 的 resolveMemDir() 里，三个 tools 共用同一份 ——
 * 别再在这里写第二套回退，否则「插件读 A、脚本写 B」这种错位会重新长出来。
 *
 * 配置了路径时顺带确保目录存在 —— 不只 build() 走这条路，像 memory_curve_days
 * 这种直接调 listDays 的工具也经过这里。
 */
const memDir = () => {
  const configured = configuredMemDir();
  if (configured) {
    ensureConfiguredDir();
    return configured;
  }
  return resolveMemDir();
};

// 摘要固定在 <DSH_HOME>/memory-notes —— 和流水目录分开，流水可以在任何地方。
const digestDir = () => join(dshHome(), 'memory-notes', '_digest');
const gradeFile = () => join(dshHome(), 'memory-notes', '_事件分级.md');
const accessFile = () => join(dshHome(), 'memory-notes', '_access.json');

const MAX_L1 = 12, MAX_L2 = 20, MAX_L3 = 8, INDEX_DAYS = 10;

const PAD = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`; };

// 报告与工具输出统一用本地时间。toISOString() 是 UTC：流水按本地日分桶、event 键按本地时分，
// 两者混用会让凌晨 0–8 点的事件在报告里显示成前一天，整体差一个时区。
const fmtMD = (ms) => { const d = new Date(ms); return `${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${PAD(d.getHours())}:${PAD(d.getMinutes())}`; };
const fmtYMD = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${PAD(d.getHours())}:${PAD(d.getMinutes())}`; };

/** 索引里的主题短语：够长就在标点或空格处断，补省略号，别切在半句中间。 */
function clipTopic(s, max = 20) {
  const t = String(s || '').replace(/[\s`*#|]+/g, ' ').trim();
  if (!t) return '—';
  if (t.length <= max) return t;
  const win = t.slice(0, max);
  const m = win.match(/^(.*[，。；、,.;:：！？!?\s])[^，。；、,.;:：！？!?\s]*$/);
  const cut = m && m[1].trim().length >= 8 ? m[1].trim() : win;
  return cut.replace(/[，。；、,.;:：！？!?]+$/, '') + '…';
}

/**
 * 流水目录的「指纹」：文件名 + 大小 + mtime。
 *
 * 只要没有文件被新增/改写/删除，指纹就不变 —— 可以复用上一次的聚类结果。
 * 这是唯一随数据量线性变差的地方：1.2MB 时单次 build 约 70ms，
 * 而 read() 每步都会调一次，等于每步都付 70ms。
 */
function memFingerprint(dir) {
  if (!existsSync(dir)) return 'missing';
  const parts = [];
  for (const fn of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(fn)) continue;
    try {
      const st = statSync(join(dir, fn));
      parts.push(`${fn}:${st.size}:${st.mtimeMs}`);
    } catch { /* 读不到就跳过，下次指纹自然会变 */ }
  }
  parts.sort();
  return parts.join('|') + '#' + dir;
}

/** 上一次聚类的中间结果。聚类只依赖文件内容，不依赖 now。 */
let cachedCluster = null;

function build(now = Date.now()) {
  // 路径可能因为 Loader 的 live 引用而在运行时变化，目录得有人建。
  // apply 时建过一次，之后每次 build 再确认一下（目录已存在时只是一次 stat）。
  ensureConfiguredDir();
  const dir = memDir();

  // 指纹只取流水文件（名 + 大小 + mtime）。_access.json 不能进来 —— touch() 每次查询
  // 都会写它，一旦进指纹，「查过一条再读」就会把缓存打掉，等于没缓存。
  // 访问计数与分级本来每次都要按 now 重算，不需要靠指纹判断。
  const fp = memFingerprint(dir);

  if (cachedCluster === null || cachedCluster.fp !== fp) {
    const entries = readEntries(dir);
    cachedCluster = { fp, entries, events: clusterEvents(entries) };
  }
  const { entries, events } = cachedCluster;
  // 访问证据：这个事件下所有 id 的累计被查次数
  const accessFn = (ev) => sumAccess(accessFile(), ev.ids || []);
  const graded = gradeEvents(events, now, accessFn);
  for (const g of graded) {
    const src = events[g.idx];
    g.texts = src?.texts || [];
    g.ids = src?.ids || [];
    g.state = stateOf({ accessCount: g.accessCount, lastAccess: g.lastAccess, R: g.R }, now);
  }
  return { entries, events, graded };
}

function report(graded) {
  const L = ['# 事件分级（遗忘曲线）', '',
    `> 生成 ${fmtYMD(Date.now())}　事件 ${graded.length} 个`, '',
    '> `S = ln(1+条数)×(1+0.35·ln(1+跨度天数))×(1+密度/60)`　`R = exp(−距今小时÷(S×24))`', '',
    '| 等级 | 事件数 |', '|---|---|'];
  const c = {};
  for (const g of graded) c[g.level] = (c[g.level] || 0) + 1;
  for (const k of ['L1', 'L2', 'L3', 'L4', 'L5']) L.push(`| ${LEVEL_NAME[k]} | ${c[k] || 0} |`);
  for (const lv of ['L1', 'L2', 'L3', 'L4', 'L5']) {
    const list = graded.filter((g) => g.level === lv);
    if (!list.length) continue;
    L.push('', `## ${LEVEL_NAME[lv]}（${list.length}）`, '',
      '| # | 开始 | 条数 | 跨度 | 密度 | S | R | 查过 | 状态 | 首句 |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const g of list) {
      const t = fmtMD(g.startAt);
      const head = (g.head || '').replace(/[|`*#]/g, '').slice(0, 60);
      const st = STATE_LABEL[g.state] || g.state || '-';
      L.push(`| ${g.idx} | ${t} | ${g.count} | ${g.spanDays}天 | ${g.density} | ${g.S} | ${g.R} | ${g.accessCount || 0}次 | ${st} | ${head} |`);
    }
  }
  return L.join('\n') + '\n';
}

/** 日期索引：最近 N 天，每天一行 */
function dayIndex(graded) {
  const byDay = new Map();
  for (const g of graded) {
    const d = dayOf(g.startAt);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(g);
  }
  const rows = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, INDEX_DAYS);
  return rows.map(([day, list]) => {
    const n = list.reduce((a, g) => a + g.count, 0);
    const c = { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 };
    for (const g of list) c[g.level]++;
    // 主题词对中文天天是碎片（「拟宿」「的页」），索引行改用当天首个事件的首句，
    // 一句话就能认出那天在干什么。
    const first = list.slice().sort((a, b) => a.startAt - b.startAt)[0];
    const tops = clipTopic(first?.head);
    const lv = ['L1', 'L2', 'L3'].filter((k) => c[k]).map((k) => `${k}×${c[k]}`).join(' ') || '—';
    return `- ${day}　${n}条 ${list.length}事件 ${lv}　${tops}`;
  }).join('\n');
}

export function apply(ctx, config = {}) {
  // 临时停用开关。Config 里声明了 disabled，patch 里写 disabled: true 会先过 schema 校验，
  // 到这里的值是布尔 —— 不会再出现「加了守卫但永远拿到 undefined」那种假守卫。
  if (config.disabled === true) {
    console.log('[memory-curve] disabled=true，跳过全部注册');
    return;
  }

  // ── 记忆目录：cordis.patch.yml 里 config.memoryDir 那个 ──────────
  // Config 声明了 memoryDir，cordis.patch.yml 里的同名字段按它校验。
  // 字段标了 .volatile()，Loader 可能交给插件的是 live 引用（{ get() }），
  // readField() 会两种形态都吃 —— 所以这里存下 config，别缓存成字符串。
  liveConfig = config;
  ensureConfiguredDir();

  // schema 是第一道闸（.min(0).max(200)），这里是第二道 —— NaN / Infinity 都能穿过
  // typeof 检查（typeof NaN === 'number'），得用 Number.isFinite 才算数。
  const num = (v, d) => (Number.isFinite(v) ? Math.max(0, Math.min(200, v)) : d);
  const maxL1 = num(config.maxL1, MAX_L1);
  const maxL2 = num(config.maxL2, MAX_L2);
  const maxL3 = num(config.maxL3, MAX_L3);

  // 启动自检：确认 interpolate:false 真的生效。
  //
  // 流水里随时会有含 `{{` 的正文（讨论变量通道、贴报错都会），一旦 interpolate
  // 被误删或上游语义变化，整个回合会抛 unknown prompt variable 直接失败。
  //
  // 以前这里拿一段本地拼的字符串做 includes 判断 —— 那是恒真的伪自检，
  // 什么也没验证。真正的断言在注册处：context 的 interpolate 选项和实际
  // 传进去的值必须是 false。这里打印注册时传入的常量值 —— 和 selftest 里对注册对象的断言互相印证。

  // 启动时补一次每日摘要（失败不影响注入）
  try {
    const r = buildDailies({ memDir: memDir(), digestDir: digestDir() });
    console.log(`[memory-curve] 每日摘要 ${r.written.length} 份，条目 ${r.total}，事件 ${r.events}`);
  } catch (err) {
    console.warn('[memory-curve] 每日摘要生成失败:', String(err?.message ?? err));
  }

  let collectorStatus = null;
  if (config.autoCollect === true) {
    ctx.effect(() => {
      const bounded = (v, d, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : d;
      const auto = mountAutoCollector(ctx, {
        memDir,
        sessionsDir: join(dshHome(), 'sessions'),
        includeSubagents: config.collectSubagents === true,
        excludeCwds: config.collectExcludeCwds || '',
        excludeSessions: config.collectExcludeSessions || '',
        flushMs: bounded(config.collectFlushMs, 1500, 100, 60000),
        scanMs: bounded(config.collectScanMs, 60000, 1000, 3600000),
        summaryMs: bounded(config.collectSummaryMs, 5000, 100, 60000),
        onDirty: async (days, dir) => {
          buildDailies({ memDir: dir, digestDir: digestDir(), days });
          cachedCluster = null;
          dropReadCache();   // 采集刚落盘，别让 3 秒缓存把新条数压下去
          const { graded } = build();
          mkdirSync(join(dshHome(), 'memory-notes'), { recursive: true });
          await writeAtomic(gradeFile(), report(graded));
        },
      });
      collectorStatus = auto.collector.status;
      console.log('[memory-curve] 自动采集已启用（正文事件 + 增量补漏）');
      return () => auto.dispose();
    }, 'memory-curve.collector');
  }

  const READ_TTL = 3000;
  let readCache = { at: 0, text: '' };
  // 采集落盘后立刻作废缓存。函数声明有提升，onDirty 里可以提前调用。
  function dropReadCache() { readCache = { at: 0, text: '' }; }
  const read = () => {
    // 短周期复用：DSH 每一步都会重新组装系统提示，一次修复里连续几次工具调用
    // 会各自触发一次完整重算（指纹 + 145 事件分级 + 渲染，实测约 27ms）。
    // 3 秒内直接返回上一份结果，自动采集新写入最多延迟这么久才反映到索引里。
    const nowMs = Date.now();
    if (readCache.text && nowMs - readCache.at < READ_TTL) return readCache.text;
    try {
      const { entries, events, graded } = build();
      const body = renderForPrompt(graded, { maxL1, maxL2, maxL3 });
      const c = {};
      for (const g of graded) c[g.level] = (c[g.level] || 0) + 1;
      const idx = dayIndex(graded);
      const text = [
        '【记忆事件索引 · 按遗忘曲线】',
        `完整流水 ${memDir()}（${entries.length} 条 / ${events.length} 事件）`,
        `每日摘要 ${digestDir()}　总报告 ${gradeFile()}`,
        ...(collectorStatus ? [collectorStatus.lastError
          ? `自动采集：待重试 — ${collectorStatus.lastError.slice(0, 160)}`
          : `自动采集：已启用；最近落盘 ${collectorStatus.lastSuccess ? fmtYMD(Date.parse(collectorStatus.lastSuccess)) : '等待首次完成'}；待摘要 ${collectorStatus.pendingDays} 天`] : []),
        `分级：L1 ${c.L1 || 0}　L2 ${c.L2 || 0}　L3 ${c.L3 || 0}　L4 ${c.L4 || 0}　L5 ${c.L5 || 0}`,
        '',
        '【最近几天 · 定位用】',
        idx,
        '',
        '查法：① 先看下面索引认出大致哪天 → memory_curve_day(日期) 读摘要；',
        '　　　② 问具体术语/偏移/文件名时别指望摘要里一定有那个词，直接 memory_search(关键词) 全流水搜；',
        '　　　③ 拿到 id 后 memory_curve_raw(id) 取全文；整个事件要一起看时用 memory_curve_raw(event:"e_日期_时分")，范围写法 m_a..m_b 只取首尾两条，别当「整段」用。',
        '**回答涉及记忆时必须带 id 或日期**，没查到就说没查到，不许凭标题编。',
        '状态：热=默认召回　冷=降权但可查　档=只留索引（原文仍在）。',
        '用户问「之前/以前/记不记得/上次」这类遗忘型问题时，冷和档都要查，不要只看热的。',
        '命令、偏移、字节、哈希一律以原文为准。',
        '',
        body || '（暂无高留存事件）',
      ].join('\n');
      readCache = { at: nowMs, text };
      return text;
    } catch (err) {
      return `【记忆事件索引】读失败：${String(err?.message ?? err)}\n完整流水仍在 ${memDir()}`;
    }
  };

  // 主通道：runtime context。
  //
  // 为什么不用提示变量：某些 profile 的 prompt-inject section 带 `interpolate: false`，
  // 而且第三方改写插件会把非白名单的 `{{x}}` 拆成 `{ {x}}` —— 变量引用在这条路径上
  // 彻底无效（实测系统提示里 {{memory_curve}} 原样残留）。
  //
  // 但 assemble() 里有 complete section 时只替换 `sections`，
  // `...transformed` 把 contexts 原样带出来 —— context 能穿过 complete 封锁。
  // 而且 PromptContext.text 允许传函数（typeof entry.text === "function" 时每次调用），
  // 正好做到「每步重新读盘」。
  ctx.effect(() => {
    const prompt = ctx.systemPrompt;
    if (config.injectContext === false) {
      console.log('[memory-curve] injectContext=false，索引不注入；六个工具照常可用');
      return () => {};
    }
    if (typeof prompt?.context !== 'function') {
      console.warn('[memory-curve] 没有 systemPrompt.context，索引这一轮不注入');
      return () => {};
    }
    // 先打日志再 return —— 之前写在 return 后面，是永远执行不到的死代码
    console.log(
      `[memory-curve] context 注册: interpolate=${CONTEXT_INTERPOLATE}`
      + (CONTEXT_INTERPOLATE === false ? '（正文含 {{ 不会被解析）' : ' ← 危险，应为 false'),
    );
    return prompt.context({
      name: 'memory-curve-index',
      order: 900,
      text: () => read(),
      // 必须关插值。renderContextSections 默认会 interpolate(context, variables)，
      // 而记忆正文里只要出现 `{{...}}`（讨论变量通道、写配置、贴报错都会出现），
      // 就会被当变量名解析，找不到就抛 unknown prompt variable —— 整个原子崩掉。
      // 实测踩过：agent 侧报 "unknown prompt variable \"{{memory_curve}}\" in context \"memory-curve-index\""。
      interpolate: CONTEXT_INTERPOLATE,
    });
  }, 'memory-curve.context');

  // 兼容通道：作用域里没有 context 但有 variable 时退回变量（别的 profile 可能走这条）
  //
  // injectContext 的守卫必须放在这里，不只是主通道那处。否则「只有 variable 没有 context」
  // 的 profile 上 injectContext=false 照样注册，日志还照常打「索引不注入」—— 配置说了假话，
  // 比静默失效更难查。判断放在第一句，日志分支也不会提前走到。
  ctx.effect(() => {
    const prompt = ctx.systemPrompt;
    if (config.injectContext === false) return () => {};
    if (typeof prompt?.context === 'function' || typeof prompt?.variable !== 'function') return () => {};
    return prompt.variable('memory_curve', read);
  }, 'memory-curve.variable');

  ctx.effect(() => {
    const tools = ctx.tools;
    if (typeof tools?.register !== 'function') {
      console.warn('[memory-curve] 没有 tools.register');
      return () => {};
    }
    const disposers = [];

    // ── 1. 日期列表
    disposers.push(tools.register({
      name: 'memory_curve_days',
      description: '列出所有有记忆的日期，每天一行（条数/事件数/分级/关键主题）。定位先看这个。',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_a, v) => [{ type: 'text', text: v.text }],
      },
      async execute() {
        const days = listDays({ memDir: memDir(), digestDir: digestDir() });
        return { text: `共 ${days.length} 天：\n` + days.join('\n') };
      },
      presentCall: () => ({ card: 'generic', title: '记忆日期', kind: 'other', rawInput: '' }),
    }));

    // ── 1.5 全流水关键词搜索（摘要命中不了时的兜底）
    disposers.push(tools.register({
      name: 'memory_search',
      description: [
        '在所有日期的完整流水里搜关键词，返回日期 + memory_id + 上下文片段。',
        '摘要里的词是算法挑的，中文还存在二元切词问题（「悬浮窗」会变「悬浮/浮窗」），',
        '所以问具体术语、偏移、文件名时，直接用这个搜，别指望摘要里一定有那个词。',
      ].join('\n'),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          pattern: { type: 'string', description: '关键词或正则，如 maxWait、fetchSize、连接池' },
          maxHits: { type: 'integer', description: '最多返回几条，默认 20' },
        },
        required: ['pattern'],
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_a, v) => [{ type: 'text', text: v.text }],
      },
      async execute(args) {
        const pat = String(args?.pattern || '').trim();
        if (!pat) return { text: '要给个关键词' };
        const maxHits = typeof args?.maxHits === 'number' ? args.maxHits : 20;
        // 建 memoryId -> 状态的映射，供 searchAll 降权。
    // 一个事件的所有 ids 共享同一个状态（状态是事件级的）。
    const stateMap = new Map();
    try {
      const g = build();
      for (const ev of g.graded) {
        const st = stateOf({ accessCount: ev.accessCount, lastAccess: ev.lastAccess, R: ev.R });
        for (const id of ev.ids || []) stateMap.set(id, st);
      }
    } catch { /* 状态取不到就不降权，不影响搜索 */ }

    const r = searchAll({ memDir: memDir(), pattern: pat, maxHits, digestDir: digestDir(), stateMap });
        if (!r.total) return { text: `没搜到「${pat}」` };
        const lines = r.hits.map((h) => {
          const first = h.ids[0], last = h.ids[h.ids.length - 1];
          const ids = first === last ? first : `${first}..${last}`;
          const more = h.merged ? `（含${h.merged + 1}条相邻）` : '';
          return `- ${h.day} ${h.time} [${ids}]${more}　${h.snippet}`;
        });
        const warn = r.mode === 'RELAXED'
          ? `\n注意：原词无结果，已放宽到「${r.usedTerms.join(' ')}」（降 ${r.relaxed} 级）。`
          : '';
        return {
          text: `# 「${pat}」命中 ${r.total} 条（取样时按相关度筛过，列表按时间排序，显示 ${r.hits.length}）${warn}\n\n` +
                lines.join('\n') +
                (r.total > r.hits.length ? `\n\n（还有 ${r.total - r.hits.length} 条，加词缩小或加大 maxHits）` : '') +
                `\n\n取全文用 memory_curve_raw(id 或 ids)。`,
        };
      },
      presentCall: (a) => ({ card: 'generic', title: '搜记忆', kind: 'other', rawInput: a?.pattern || '' }),
    }));

    // ── 2. 读某天摘要
    disposers.push(tools.register({
      name: 'memory_curve_day',
      description: '读某一天的摘要（事件清单 + 首尾句 + 关键词）。先查摘要，再决定要不要回原文。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { day: { type: 'string', description: '日期，如 2026-11-09' } },
        required: ['day'],
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_a, v) => [{ type: 'text', text: v.text }],
      },
      async execute(args) {
        const day = String(args?.day || '').trim();
        if (!day) return { text: '要给个日期，例如 2026-11-09' };
        const t = readDigest({ digestDir: digestDir(), day });
        if (t) return { text: t };
        // 摘要没生成过就现做 —— 只补这一天。不传 days 会把全部日子的摘要
        // 重算一遍（全量聚类 + 全量写盘），查一个不存在的日期就白烧一次。
        try { buildDailies({ memDir: memDir(), digestDir: digestDir(), days: [day] }); } catch {}
        const t2 = readDigest({ digestDir: digestDir(), day });
        return { text: t2 || `没有 ${day} 的摘要。可用 memory_curve_days 看有哪些天。` };
      },
      presentCall: (a) => ({ card: 'generic', title: '查摘要', kind: 'other', rawInput: a?.day || '' }),
    }));

    // ── 3. 回原文（可按关键词过滤）
    disposers.push(tools.register({
      name: 'memory_curve_raw',
      description: [
        '回查原始记忆。三种用法，优先用 id：',
        '  ① id：某个 memory_id（如 m_20261109_000087），精确取那一条；',
        '  ② ids：一串 memory_id，批量取；',
        '  ③ day + pattern：按日期 + 关键词/正则模糊找。',
        '摘要里每条事实后面都带 id，顺手抄过来查，别凭摘要猜。',
      ].join('\n'),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', description: '单个 memory_id，形如 m_20261109_000087' },
          ids: { type: 'array', items: { type: 'string' }, description: '元素可为单条 m_xxx、事件键 event:e_yyyyMMdd_HHmm、或范围 m_a..m_b。注意：哈希 id 不能算术展开，范围只取首尾两条；要全量请用事件键' },
          day: { type: 'string', description: '日期，如 2026-11-09' },
          pattern: { type: 'string', description: '关键词或正则；留空返回当天开头若干条' },
          maxChars: { type: 'integer', description: '最多返回多少字符，默认 4000' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_a, v) => [{ type: 'text', text: v.text }],
      },
      async execute(args) {
        const maxChars = typeof args?.maxChars === 'number' ? args.maxChars : 4000;

        // ① 单条 id
        if (typeof args?.id === 'string' && args.id.trim()) {
          const id = args.id.trim();
          const one = readById({ memDir: memDir(), id });
          if (!one) return { text: `没有 id ${id}，检查是不是抄错了` };
          touch(accessFile(), [id], 'raw:id');
          return { text: `# ${one.id}　${one.day}\n\n${one.text}` };
        }
        // ② 批量 ids（元素可以是单条，也可以是 m_a..m_b 范围）+ 可选 pattern 二次过滤
        if (Array.isArray(args?.ids) && args.ids.length) {
          let ids = [];
          let evInfo = null;
          for (const spec of args.ids) {
            const s2 = String(spec || '').trim();
            // event:e_20261109_1255 -> 从 ids.json 取完整数组。
            // 摘要里标 +N（不连续）的事件只能这样取，靠范围展开会拉进不属于它的条目。
            if (s2.startsWith('event:')) {
              const r2 = eventIds({ digestDir: digestDir(), eventKey: s2.slice(6) });
              if (!r2) return { text: `找不到事件 ${s2}，检查 _digest 下的 ids.json 是否存在` };
              evInfo = r2;
              ids = ids.concat(r2.ids);
            } else {
              ids = ids.concat(expandRange(s2));
            }
          }
          // 范围内二次过滤：摘要事件头覆盖 28 条时，通常只要其中几条
          const pat = String(args?.pattern || '').trim();
          let pool = ids;
          if (pat) {
            const { re } = makeMatcher(pat);   // 默认字面量，/.../ 才是正则
            const hit = [];
            for (const id of ids) {
              const one = readById({ memDir: memDir(), id });
              if (!one) continue;
              if (re.test(one.text)) hit.push(id);
            }
            pool = hit;
          }
          if (!pool.length) return { text: `范围内没命中${pat ? `「${pat}」` : ''}（检查 ${ids.length} 条）` };
          const r = readByIds({ memDir: memDir(), ids: pool, maxChars });
          // 只记「真正进入上下文」的那几条（受 maxChars 限制，实际取到 r.found 条）。
          // 整组 pool 全记会把没返回的也标成「被查过」，冷热信号就废了。
          touch(accessFile(), pool.slice(0, r.found), 'raw:ids');
          const head = pat ? `范围内命中 ${pool.length}/${ids.length} 条` : `共 ${r.total} 条`;
          const tail = r.found < r.total ? `\n\n（本次只取到 ${r.found} 条，受 maxChars=${maxChars} 限制；要更多就加大 maxChars 或用 pattern 缩小）` : '';
          return { text: `# ${head}\n\n${r.text}${tail}` };
        }
        // ③ 日期 + 关键词
        const day = String(args?.day || '').trim();
        if (!day) return { text: '要给 id、ids 或 day 之一' };
        const r = grepDay({ memDir: memDir(), day, pattern: args?.pattern, maxChars });
        if (!r) return { text: `没有 ${day} 那天完整流水` };
        // 按关键词模糊查也记访问：命中的条目算被用过
        try {
          const hitIds = [...r.text.matchAll(/m_[0-9]{8}_[0-9a-f]{6}/g)].map((x) => x[0]);
          if (hitIds.length) touch(accessFile(), [...new Set(hitIds)], 'raw:day:' + (args?.pattern || ''));
        } catch {}
        return { text: `# ${day}　命中 ${r.total} 条\n\n${r.text}` };
      },
      presentCall: (a) => ({ card: 'generic', title: '查原文', kind: 'other', rawInput: `${a?.day || ''} ${a?.pattern || ''}`.trim() }),
    }));

    // ── 4. 重算摘要 + 分级
    disposers.push(tools.register({
      name: 'memory_curve_build',
      description: '重新生成所有每日摘要，并重算事件分级写进 _事件分级.md。',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { days: { type: 'integer' }, entries: { type: 'integer' }, events: { type: 'integer' }, chars: { type: 'integer' }, report: { type: 'string' } },
          required: ['days', 'entries', 'events', 'chars', 'report'],
        },
        render: (_a, v) => [{ type: 'text', text: `重算完成：${v.days} 天 / ${v.entries} 条 / ${v.events} 事件，摘要共 ${v.chars} 字符\n分级报告：${v.report}` }],
      },
      async execute() {
        const r = buildDailies({ memDir: memDir(), digestDir: digestDir() });
        const { graded } = build();
        try { mkdirSync(join(dshHome(), 'memory-notes'), { recursive: true }); } catch {}
        try { writeFileSync(gradeFile(), report(graded), 'utf8'); } catch {}
        const chars = r.written.reduce((a, x) => a + x.chars, 0);
        return { days: r.written.length, entries: r.total, events: r.events, chars, report: gradeFile() };
      },
      presentCall: () => ({ card: 'generic', title: '重算记忆', kind: 'other', rawInput: '' }),
    }));

    // ── 5. 按等级翻事件
    disposers.push(tools.register({
      name: 'memory_curve_show',
      description: '按等级（L1..L5）列出事件，或按序号取单个事件的全部原文。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          level: { type: 'string', description: 'L1/L2/L3/L4/L5，留空表示全部' },
          index: { type: 'integer', description: '事件序号；给了就返回该事件原文' },
          maxChars: { type: 'integer', description: '默认 4000' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_a, v) => [{ type: 'text', text: v.text }],
      },
      async execute(args) {
        const { graded } = build();
        const maxChars = typeof args?.maxChars === 'number' ? args.maxChars : 4000;
        if (typeof args?.index === 'number') {
          const g = graded.find((x) => x.idx === args.index);
          if (!g) return { text: `没有第 ${args.index} 号事件（共 ${graded.length} 个，序号 0..${graded.length - 1}）` };
          const full = (g.texts || []).join('\n\n');
          const body = full.length > maxChars
            ? full.slice(0, maxChars) + `\n…（已截断，全文 ${full.length} 字符；加大 maxChars 取全文）`
            : full;
          return { text: `# 事件 ${g.idx}　${LEVEL_NAME[g.level]}　S=${g.S} R=${g.R}　${g.count}条\n\n${body}` };
        }
        const pool = args?.level ? graded.filter((g) => g.level === args.level) : graded;
        const L = [`# 事件列表（${pool.length} 个）`, ''];
        let used = 0;
        for (const g of pool) {
          const t = fmtMD(g.startAt);
          const st = STATE_LABEL[g.state] || '-';
          const acc = g.accessCount ? ` 查${g.accessCount}` : '';
          const line = `- #${g.idx} [${g.level}/${st}] ${t} ${g.count}条 R=${g.R}${acc}　${(g.head || '').slice(0, 46)}`;
          if (used + line.length > maxChars) { L.push(`（已显示 ${L.length - 2} / ${pool.length} 条，后面还有；缩小 level 或加大 maxChars）`); break; }
          L.push(line); used += line.length;
        }
        return { text: L.join('\n') };
      },
      presentCall: (a) => ({ card: 'generic', title: '翻事件', kind: 'other', rawInput: JSON.stringify(a || {}) }),
    }));

    return () => { for (const d of disposers) { try { d?.(); } catch {} } };
  }, 'memory-curve.tools');
}

// 注意：这里刻意没有 `export default`。
//
// Cordis Loader 的 unwrapExports() 是 `exports.default ?? exports` ——
// 只要模块提供了 default，整个命名空间就会被折叠成那个 default 对象，
// `Config` 作为命名导出直接丢失。后果是：
//   registry.plugin() 拿到的 plugin.Config === undefined
//   → fiber.runtime.Config === undefined
//   → dsh-settings 的 describe() 判定 schema === undefined 并跳过
//   → 配置编辑器永远 status=unavailable、revision=undefined
//
// 只用命名导出（name / inject / Config / apply）就能让 Loader 拿到完整对象。
