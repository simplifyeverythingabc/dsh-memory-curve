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
 * 分级依据：**公式与阈值不在文件头复制。**
 *   唯一可信的表述是 report() 生成的那段公式头 —— selftest 的「报告公式文案」
 *   在守它。系数与阈值本身在 src/events.js：POWER_K / POWER_BETA 常量、
 *   gradeEvents() 里的绝对阈值与相对配额。
 *
 *   为什么不再抄一份：0.3.9 → 0.5.4 之间这里一直是老的指数公式和老阈值，
 *   实际早换成了幂律 + 再巩固 + 四个乘数。文件头是新读者第一眼看到的东西，
 *   写错了比没有更糟；同一份公式两处维护，必然再次漂移。
 *
 * 「遗忘」的动作：L4/L5 不进上下文，但文件照旧留着，需要时按上面那条链去翻。
 */
import { existsSync, writeFileSync, mkdirSync, readdirSync, statSync, readFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
import { readEntries, clusterEvents, gradeEvents, renderForPrompt, currentThreads as clusterThreads, LEVEL_NAME } from './events.js';
import { resolveMemDir, dshHome, normalizeDir } from './paths.js';
import { buildDailies, readDigest, listDays, grepDay, readById, readByIds, searchAll, expandRange, eventIds, makeMatcher } from './digest.js';
import { touch, sumAccess, stateOf, STATE_LABEL, suppress, shelve, SUPPRESS_DEFAULT } from './access.js';
import { createEmbedder, EMBED_MIRROR } from './embed.js';
import { narrateDay } from './narrate.js';
import { scanFiles, planReuse, loadIndex, saveIndex } from './persist.js';
import { mountAutoCollector, writeAtomic } from './collector.js';

export const name = 'memory-curve';

// `compaction` 是 0.16.4 加的，用来验证「模型主动压缩历史」能不能做。
//
// 已知风险：cordis 的 inject 是 **required**，服务不可达时插件会无限等待。
// profile 的 cordis.patch.yml L205-214 记着一段历史 —— 在**预设作用域**里，
// inject:['sessions'] / inject:[] / inject:['compaction'] 三种写法全失败，
// 最后连带会话 resume 一起挂。
//
// 但那是**预设作用域**。本插件挂在 bundle 层的全局 patch，
// 而 compaction-basic 也挂在同一层的全局 patch（L416），所以这里可能拿得到。
//
// 失败怎么发现：apply 一进来就写 _compaction-probe.json。
//   文件更新 → 插件加载成功
//   文件时间戳不动 → 插件在 waiting，没跑起来（那时系统提示里也不会有记忆索引）
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
  maxL1: z.number().min(0).max(200).default(6).description('L1 事件最多列几条，控制注入体积。'),
  injectContext: z
    .boolean()
    .default(true)
    .description('是否把记忆索引注入系统提示。设 false 后索引不再占每步 token，六个 memory_curve_* 工具照常可用，按需现查。'),
  maxL2: z.number().min(0).max(200).default(8).description('L2 事件最多列几条。'),
  maxL3: z.number().min(0).max(200).default(3).description('L3 事件最多列几条。'),
  maxThreads: z
    .number()
    .min(0)
    .max(20)
    .default(2)
    .description('「主题线」最多列几条（把同一条线索上的多个事件压成一行）。设 0 关闭这一段。'),
  autoCollect: z.boolean().default(false).description('启用会话消息自动采集、启动补漏和摘要刷新；只保存用户与助手正文。'),
  collectSubagents: z.boolean().default(false).description('自动采集是否包含子代理；默认排除，不影响已有流水。'),
  collectExcludeCwds: z.string().default('').description('排除的工作目录，换行或分号分隔，包含其子目录。'),
  collectExcludeSessions: z.string().default('').description('排除的会话 ID，换行或分号分隔。'),
  collectFlushMs: z.number().min(100).max(60000).default(1500).description('消息批量落盘间隔（毫秒）。'),
  collectScanMs: z.number().min(1000).max(3600000).default(60000).description('日志增量补漏间隔（毫秒）；启动时也会补漏。'),
  collectSummaryMs: z.number().min(100).max(60000).default(5000).description('有变动时摘要合并刷新间隔（毫秒）。'),
  // ── 语义向量（0.12.0 / 0.13.1 补声明）────────────────────────────
  // 这两个字段 0.12.0 时**只在 apply() 里读、没在 Config 里声明**，而 schemastery 会把
  // 未声明的字段丢掉 —— 于是 config.semanticRecall 永远是 undefined，
  // `!== false` 恒真，语义功能根本关不掉；embedMirror 也永远拿不到配置值。
  // 跟 0.4.x 那次「加了守卫但永远拿到 undefined」是同一类事故，只是这次是配置项。
  semanticRecall: z.boolean().default(true).description('启用语义向量（bge-small-zh-v1.5，需装 @xenova/transformers）。关闭后只用实体指纹匹配，行为与 0.11.0 一致。'),
  embedMirror: z.string().default('https://hf-mirror.com').description('模型下载镜像。墙外可改 https://huggingface.co。'),
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
  if (dir === lastEnsuredDir) return;   // 同目录只建一次；目录若被外部删掉不会自动重建，getDir 失败时会把 lastEnsuredDir 清空重试
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
// 主题线标签仓库。放 memory-notes 根而不是 _digest 里：_digest 是每日摘要，会被
// 重算/清理；标签属于长期标识，不该跟着摘要一起没。
const threadsFile = () => join(dshHome(), 'memory-notes', '_threads.json');
// 事件索引缓存（0.14.0）。存的是「从条目推出、不随时间和访问变化」的事件骨架，
// 让新进程能跳过全量解析与聚类。见 persist.js 顶部关于判据与边界的说明。
const eventsFile = () => join(dshHome(), 'memory-notes', '_events.json');

/**
 * 主题线标签仓库的读写。
 *
 * 为什么需要它：标签以前每次现算，取「全体成员共享的最短实体」。成员里一旦掺进
 * 新事件，共享集合就变、标签跟着换 —— 实测同一条线（成员一个没动）几小时内从
 * `nativeauth` 变成 `tenprotect`，看的人会以为是两件事。
 *
 * 现在线的身份是**起点事件的毫秒时间戳**：起点不变，标签永远复用第一次算出来的。
 * 仓库挂在 memory-notes 根（不是 _digest：那边是每日摘要，会被重算/清理）。
 *
 * 读失败一律当空仓库 —— 标签丢了最多是重新算一次名字，不能让整个 build 挂掉。
 */
function loadThreadLabels() {
  try {
    const obj = JSON.parse(readFileSync(threadsFile(), 'utf8'));
    const map = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    return { map, dirty: false };
  } catch {
    return { map: {}, dirty: false };
  }
}

/**
 * 写回标签仓库，只保留仍然存在的线。
 *
 * 触发条件有两个：有新线的标签要写（dirty），**或者**仓库里堆着已经不存在的线。
 * 第二个条件不能省 —— 线会重组（起点合并/消失），那些记录不 dirty 却该被清掉；
 * 只按 dirty 判断的话陈旧记录会永远留着，文件越滚越大，而且下次同名起点复用时
 * 会捞到一个本该失效的旧名字。
 */
function saveThreadLabels(store, liveKeys) {
  if (!store) return;
  const live = new Set(liveKeys);
  const stale = Object.keys(store.map).filter((k) => !live.has(k));
  if (!store.dirty && !stale.length) return;      // 没新线、没陈旧 → 一个字节都不写
  const keep = {};
  for (const k of liveKeys) if (store.map[k]) keep[k] = store.map[k];
  try {
    mkdirSync(dirname(threadsFile()), { recursive: true });
    // 原子写：仓库里其它关键落盘（collector 的 writeAtomic）都是 tmp + rename。
    // 这张表一旦崩在写一半，JSON 会被截断 → loadThreadLabels 按「读失败当空仓库」
    // 处理 → 所有线重新起名一次 —— 恰好是 0.6.0 要消灭的那个症状。
    const tmp = threadsFile() + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify(keep), 'utf8');
    renameSync(tmp, threadsFile());
    store.map = keep;
    store.dirty = false;
  } catch {
    // 写不进去就下次再说：本次渲染用的还是内存里那份，不影响结果
  }
}

/**
 * 注入配额的「期望值」。
 *
 * ⚠️ **这些常量不决定运行时行为** —— schemastery 会先用 `Config` 里的 `.default()`
 * 把 config 填满，所以 `num(config.maxX, MAX_X, …)` 里的兜底值**永远拿不到**。
 *
 * 真正生效的是 `Config` 声明里的 `.default()`。这里放一份是为了：
 *   ① 有个地方能一眼看出「现在配额是多少」
 *   ② `selftest` 会断言两者一致，防它们漂
 *
 * 已经漂过一次：0.15.0 把 MAX_THREADS 改成 2，但 Config.maxThreads 还是 .default(3)，
 * 于是主题线一直显示 3 条，改了个寂寞。
 */
const MAX_L1 = 6, MAX_L2 = 8, MAX_L3 = 3, MAX_THREADS = 2, INDEX_DAYS = 5;

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
/** 语义向量器。null = 未启用；status 非 ready 时所有调用点自动退回字符匹配。 */
let embedder = null;

export function build(now = Date.now()) {
  // 路径可能因为 Loader 的 live 引用而在运行时变化，目录得有人建。
  // apply 时建过一次，之后每次 build 再确认一下（目录已存在时只是一次 stat）。
  ensureConfiguredDir();
  const dir = memDir();

  // 指纹只取流水文件（名 + 大小 + mtime）。_access.json 不能进来 —— touch() 每次查询
  // 都会写它，一旦进指纹，「查过一条再读」就会把缓存打掉，等于没缓存。
  // 访问计数与分级本来每次都要按 now 重算，不需要靠指纹判断。
  const fp = memFingerprint(dir);

  if (cachedCluster === null || cachedCluster.fp !== fp) {
    // ── 持久化索引（0.14.0）：跨进程复用已整理好的事件 ──────────────
    //
    // 内存缓存 cachedCluster 在新进程里必然是 null，所以「跨进程」这条只能靠磁盘。
    // 判据必须是**逐文件**的（persist.planReuse）—— 用整体指纹的话，对话里每加
    // 一条消息指纹就变，等于每次都全量重建，而「加一条消息」正是最常见的操作。
    let seed = null;
    let seedFiles = null;
    let files = null;
    if (cachedCluster === null) {
      try {
        files = scanFiles(dir);
        const idx = loadIndex(eventsFile());
        if (idx) {
          const plan = planReuse(idx.files, files);
          // 'none'（一个文件都没变）和 'tail'（只有末尾几天变了）在这里**走同一条路**：
          // 都交给 clusterEvents 的 seed —— 它复用全部旧事件，从最后一个事件的
          // endIdx+1 接着聚类，新条目通过「延长最后一个未封口事件」并入。
          // 只有 'full'（中间某天变了 / 文件被删）才放弃索引。
          //
          // 0.14.x 的注释这里写着「'tail' 只重算尾部」，但当时没有任何代码实现
          // 那个分支，`tailFromDay` 也从没被读过。注释描述了不存在的行为，
          // 已经在 persist.js 的 planReuse 里一并改正。
          if (plan.mode !== 'full') {
            seed = { entryCount: idx.entryCount, events: idx.events };
            seedFiles = idx.files;
          }
        }
      } catch { /* 索引不可用就走全量，不影响正确性 */ }
    }

    const entries = readEntries(dir);

    // 索引里**不存** items/texts（它们占索引 94%，且能从 startIdx..endIdx 精确重建）。
    // 必须在 clusterEvents **之前**补回去：它内部的 signalDensity 要读 texts，
    // 空 texts 会让显著性算错 —— 而且不会报错，只会让分级悄悄全变 L5。
    if (seed && Array.isArray(seed.events)) {
      for (const e of seed.events) {
        if (Array.isArray(e.texts) && e.texts.length) continue;
        const s = Number.isSafeInteger(e.startIdx) ? e.startIdx : 0;
        const t = Number.isSafeInteger(e.endIdx) ? e.endIdx : s;
        const slice = entries.slice(s, t + 1);
        e.items = slice;
        e.texts = slice.map((x) => x.text);
      }
    }

    // 标签仓库：读一次 → 交给 cluster → 有新线就写回（并清掉已消失的线）
    const store = loadThreadLabels();
    const events = clusterEvents(entries, { labelStore: store, seed });
    // 无条件调一次：新线要写入，陈旧记录要清掉，两件事都在 saveThreadLabels 里判
    saveThreadLabels(store, clusterThreads().map((t) => String(t.startAt)));
    cachedCluster = { fp, entries, events };

    // 落盘条件：**文件快照变了就写**，不是「事件数变了才写」。
    //
    // 0.14.0 第一版写成「事件数变了才写」，结果 11-16 那天持续追加消息但事件数没变，
    // 索引里的 files 快照永远停在旧值 → planReuse 每次都判 'tail'，每次都重算那一天。
    // 一天很便宜，但快照滞后于语料是错的：它该跟着源文件走。
    //
    // 只有「快照一致且事件数一致」才跳过写盘 —— 那才是真的一字节未变。
    const snapshot = files || scanFiles(dir);
    const changed = !seedFiles
      || events.length !== (seed.events || []).length
      || JSON.stringify(snapshot) !== JSON.stringify(seedFiles);
    if (changed) {
      saveIndex(eventsFile(), snapshot, events, entries.length);
    }
  }
  const { entries, events } = cachedCluster;
  // 访问证据：这个事件下所有 id 的累计被查次数、提取时间线、当前残余抑制
  // now 必须传进去 —— 抑制是按半衰期恢复的，用默认的 Date.now() 会和 build(now) 错开
  const accessFn = (ev) => sumAccess(accessFile(), ev.ids || [], now);
  const graded = gradeEvents(events, now, accessFn);
  for (const g of graded) {
    const src = events[g.idx];
    g.texts = src?.texts || [];
    g.ids = src?.ids || [];
    g.state = stateOf({ accessCount: g.accessCount, lastAccess: g.lastAccess, R: g.R }, now);
  }
  return { entries, events, graded, threads: clusterThreads() };
}

/**
 * 语义关联的两个闸门，都是**量出来的**，不是拍的。
 *
 * SEM_THRESHOLD = 0.85 —— bge 族模型的余弦基线极高，真实数据 13203 对里
 *   min 0.377 / p50 0.700 / p90 0.787 / p99 0.837 / max 1.000。
 *   我第一版照常识拍了 0.55，结果 94.7% 的事件对都判成「相似」—— 等于没筛。
 *   0.85 落在 p99.5，命中 0.49%（65/13203），每个事件平均不到 1 个邻居，正好。
 *
 * SEM_MIN_CHARS —— 0.13.1 审计发现它**从来没触发过**。原来查的是 `texts.join('').length`
 * （整个事件的全部文本），实测 164 个事件最小 37 字、中位 4402 字，`< 12` 的是 **0 个**。
 *
 * 而误判的来源恰好相反：是「长事件里夹了一句『好了没』」（实测余弦 0.919）——
 * 整个事件的文本长度拦不住它。长度过滤解决不了这个问题，真正的护栏是 0.85 这个阈值
 * 本身（65 对里只有 1 对是这种误报，1.5%，可接受）。
 *
 * 所以这个常量现在只做一件真事：拦住**没有任何文本可编码**的事件。阈值降到 1。
 */
const SEM_THRESHOLD = 0.85;
const SEM_MIN_CHARS = 1;

/**
 * 提取的两个副作用：抑制竞争者（RIF）+ 扩散激活的关联。
 *
 * 放一起算是因为它们都需要「这次查了谁」和「谁跟它像」，分两遍扫等于白扫。
 *
 * 抑制：与命中事件共享 >=2 个实体的其他事件，被压住 12%（半衰期 6 小时恢复）。
 *   —— 这是真实的记忆行为：想起 A 方案会暂时压住 B 方案。但它**只进排序 rank**，
 *   不改 level，所以 B 不会凭空消失，只是排后面。
 *
 * 关联：共享实体最多的前 limit 条，作为「因为想到这个，所以想到那个」返回。
 *   —— 记忆是网络的，现在检索返回的是孤立的点，这一层把边补上。
 */
export function afterRetrieval(touchedIds, limit = 3, evsIn = null) {
  const empty = { suppressed: 0, related: [] };
  // evsIn 是给测试用的注入口：插件内走 cachedCluster（build() 已经填好），
  // 插件外（selftest / 脚本）拿不到那个模块变量，只能自己传。
  const evs = evsIn || (cachedCluster && cachedCluster.events) || [];
  if (!touchedIds || !touchedIds.length || !evs.length) return empty;

  const touched = new Set(touchedIds);
  const hit = evs.filter((e) => (e.ids || []).some((id) => touched.has(id)));
  if (!hit.length) return empty;

  // 候选：**字符和语义两套都跑，合并去重**。
  //
  // 0.12.0 第一版写的是 `if (semantic) {...} else {...}` —— 互斥。结果语义一开，
  // 字符层面明明有 9 个共享实体的邻居也看不见了（那条语义只到 0.7 出头，够不到
  // 0.85）。两套判据抓的是不同的东西：字符抓「同一个文件/函数/报错反复出现」，
  // 语义抓「同一件事换了个说法」。少任何一边都是丢信息。
  //
  // 合并规则：同一个事件两边都命中时，按各自尺度都留一条判据（sem 标记决定文案），
  // 排序用「先语义后字符」的偏序 —— 语义命中通常更难得，优先展示。
  const scored = [];
  const seen = new Map();

  // ① 字符：共享 ≥2 个实体指纹（主题线用 3，这里更松，检索时的「顺带想起」本来就该松）
  for (const e of evs) {
    if (hit.includes(e) || !e.entities || !e.entities.size) continue;
    let shared = 0;
    for (const t of hit) {
      if (!t.entities) continue;
      for (const x of t.entities) if (e.entities.has(x)) shared++;
    }
    if (shared >= 2) {
      const rec = { ev: e, score: shared, sem: false };
      scored.push(rec);
      seen.set(e, rec);
    }
  }

  // ② 语义：余弦 ≥0.85（实测 p99.5）+ 排除过短文本
  const semantic = !!(embedder && embedder.status === 'ready' && embedder.size > 0);
  if (semantic) {
    const hitKeys = hit.map((t) => (t.ids && t.ids[0]) || '').filter(Boolean);
    for (const e of evs) {
      const ek = (e.ids && e.ids[0]) || '';
      if (hit.includes(e) || !ek) continue;
      if ((e.texts || []).join('').length < SEM_MIN_CHARS) continue;
      let best = null;
      for (const hk of hitKeys) {
        const s = embedder.sim(hk, ek);
        if (s !== null && (best === null || s > best)) best = s;
      }
      if (best === null || best < SEM_THRESHOLD) continue;
      const prev = seen.get(e);
      if (prev) {
        // 两边都命中：保留语义这条（信息量更大），但记下字符共享数备查
        prev.sem = true;
        prev.score = Math.max(prev.score, best);
      } else {
        const rec = { ev: e, score: best, sem: true };
        scored.push(rec);
        seen.set(e, rec);
      }
    }
  }

  if (!scored.length) return empty;
  // 语义优先（它的尺度是 0..1，字符是整数，不能直接比大小）
  scored.sort((a, b) => (b.sem ? 1 : 0) - (a.sem ? 1 : 0) || b.score - a.score);
  const top = scored.slice(0, limit);

  const sup = suppress(accessFile(), top.flatMap((x) => x.ev.ids || []), SUPPRESS_DEFAULT);
  return { suppressed: sup.suppressed, related: top };
}

/** 把关联渲染成给人看的几行；没有关联返回空串 */
export function renderRelated(related) {
  if (!related || !related.length) return '';
  // 两套判据分开说：语义讲「相近多少」，实体讲「共享几个线索」。
  // 混着讲会让读者以为这两个数是同一回事，其实尺度完全不同。
  const anySem = related.some((r) => r.sem);
  const lines = related.map(({ ev, score, sem }) => {
    const id = (ev.ids && ev.ids[0]) || '';
    const head = String((ev.texts && ev.texts[0]) || '')
      .replace(/[`*#|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const why = sem ? `语义相近 ${Math.round(score * 100)}%` : `共享${score}个线索`;
    return `- [${id}] ${why}　${head}`;
  });
  const title = anySem ? '顺手想起 · 语义邻近' : '顺手想起 · 共享线索';
  return `\n\n【${title}】\n${lines.join('\n')}`;
}

export function report(graded) {
  const L = ['# 事件分级（遗忘曲线）', '',
    `> 生成 ${fmtYMD(Date.now())}　事件 ${graded.length} 个`, '',
    '> `S = ln(1+条数)×(1+0.35·ln(1+跨度天数))×(1+密度/60)×提取×间隔×显著×未完成×位置`', '',
    '> `R = (1 + 6.39·距今小时÷(S×24×巩固))^-0.5`　（幂律，长尾更厚；巩固=跨夜折扣）', '',
    '> 距今从「最近一次活动」与「最近一次被提取」里取更晚的那个 —— 提取即再巩固', '',
    '> 等级按绝对阈值 + 相对配额两道闸：L1≤10%、L2≤22%、L3≤25%，超出降级（标 ↓）', '',
    '| 等级 | 事件数 |', '|---|---|'];
  const c = {};
  for (const g of graded) c[g.level] = (c[g.level] || 0) + 1;
  for (const k of ['L1', 'L2', 'L3', 'L4', 'L5']) L.push(`| ${LEVEL_NAME[k]} | ${c[k] || 0} |`);
  for (const lv of ['L1', 'L2', 'L3', 'L4', 'L5']) {
    const list = graded.filter((g) => g.level === lv);
    if (!list.length) continue;
    L.push('', `## ${LEVEL_NAME[lv]}（${list.length}）`, '',
      '| # | 开始 | 条数 | 跨度 | S | R | 修正 | 查过 | 等级 | 状态 | 首句 |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const g of list) {
      const t = fmtMD(g.startAt);
      const head = (g.head || '').replace(/[|`*#]/g, '').slice(0, 60);
      const st = STATE_LABEL[g.state] || g.state || '-';
      // 修正列只显示真正起作用的乘数：全 1 就写「—」，避免三列 1.00 占满视线
      const mods = [];
      if ((g.spacing || 1) > 1) mods.push(`间${g.spacing}`);
      if ((g.salience || 1) > 1) mods.push(`显${g.salience}`);
      if ((g.retrieval || 1) > 1) mods.push(`取${g.retrieval}`);
      // 蔡加尼克是唯一可以小于 1 的乘数（已收尾会扣分），所以用绝对值判断：
      // 只写 `> 1` 的话，所有「已收尾」的扣分永远不会显示出来。
      if (Math.abs((g.zeigarnik || 1) - 1) > 0.001) mods.push(`蔡${g.zeigarnik}`);
      const mod = mods.length ? mods.join(' ') : '—';
      const lvMark = g.demoted ? `${g.level}↓` : g.level;
      L.push(`| ${g.idx} | ${t} | ${g.count} | ${g.spanDays}天 | ${g.S} | ${g.R} | ${mod} | ${g.accessCount || 0}次 | ${lvMark} | ${st} | ${head} |`);
    }
  }
  return L.join('\n') + '\n';
}

/** 日期索引：最近 N 天，每天一行 */
export function dayIndex(graded) {
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

  // ── 探测：能不能拿到 compaction 服务（0.16.2）─────────────────────
  //
  // 目的：验证「MemGPT 式主动压缩」在 bundle 层到底做不做得到。
  // `dsh-compaction` 暴露 `ctx.compaction.compactRegion(start, end, agent, signal)`，
  // 能由调用方指定 surface 范围压成一条摘要 —— 这正是 MemGPT 需要的入口。
  //
  // **但这里刻意不声明 `inject: ['compaction']`**：cordis 的 inject 是 **required**，
  // 服务在某个 scope 里不可达时插件会无限等待，连会话 resume 一起拖挂
  // （0.13.x 在预设作用域里踩过一次，见 whale-history-window 那段的记录）。
  //
  // 所以用 try/catch 只读探测几种访问方式，拿到什么打什么。探测失败不影响插件。
  try {
    const probe = [];
    const got = (fn, label) => {
      try {
        const v = fn();
        probe.push(`${label}=${v ? typeof v : 'undefined'}`);
        return v || null;
      } catch (e) {
        probe.push(`${label} 抛错:${String((e && e.message) || e).slice(0, 60)}`);
        return null;
      }
    };
    const viaGet = typeof ctx?.get === 'function'
      ? got(() => ctx.get('compaction'), 'ctx.get')
      : (probe.push('ctx.get=非函数'), null);
    const direct = got(() => ctx?.compaction, 'ctx.compaction');
    const svc = viaGet || direct;
    if (svc) {
      probe.push(`方法: compactRegion=${typeof svc.compactRegion} compactNow=${typeof svc.compactNow} compactIfNeeded=${typeof svc.compactIfNeeded}`);
    }
    const line = probe.join(' | ');
    console.log('[memory-curve] compaction 探测: ' + line);
    // GUI 版没有终端接住 console.log —— 0.16.2 那次就是这么白重启了一回。
    // 落一份 JSON 到 memory-notes，重启后直接读文件，不依赖日志。
    try {
      const f = join(dshHome(), 'memory-notes', '_compaction-probe.json');
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify({
        at: new Date().toISOString(),
        plugin: 'dsh-memory-curve',
        // 0.16.4 试过 inject:['compaction']，插件静默不加载（探测文件时间戳不更新）。
        // 现在 inject 里没有 compaction，这个字段就是当时那轮的结论。
        injectCompaction: false,
        probe: line,
        hasCompaction: Boolean(svc),
        methods: svc ? {
          compactRegion: typeof svc.compactRegion,
          compactNow: typeof svc.compactNow,
          compactIfNeeded: typeof svc.compactIfNeeded,
        } : null,
      }, null, 2), 'utf8');
    } catch { /* 写不进去就算了，不影响插件 */ }
  } catch (e) {
    console.log('[memory-curve] compaction 探测异常: ' + String((e && e.message) || e));
  }

  // ── 语义向量（0.12.0）──────────────────────────────────────────────
  // **后台加载，失败静默降级**。没装 @xenova/transformers、没网、镜像也挂 —— 都只是
  // 退回字符匹配，绝不抛。首次要下 ~100 MB（实测 33.8 秒），之后本地加载几秒；
  // 加载期间 status !== 'ready'，所有调用点自动走老路，行为与 0.11.0 完全一致。
  //
  // 关掉：config.semanticRecall = false。
  if (config.semanticRecall !== false) {
    const noteDir = join(dshHome(), 'memory-notes');
    embedder = createEmbedder({
      cacheFile: join(noteDir, '_vectors.json'),
      modelDir: join(noteDir, '_models'),
      mirror: typeof config.embedMirror === 'string' && config.embedMirror.trim()
        ? config.embedMirror.trim()
        : EMBED_MIRROR,
    });
    embedder.load();                       // 先把已缓存的向量读进来，能立刻用
    embedder.init()
      .then((st) => {
        if (st !== 'ready') {
          console.log(`[memory-curve] 语义向量不可用（${embedder.error}），退回字符匹配`);
          return 0;
        }
        // 关键：**必须先跑一次 build()**。apply() 是同步的，模型加载完成时
        // cachedCluster 还是 null（build 还没被任何工具/注入触发过），
        // 直接取 events 会拿到空数组，encode 返回 0，save 被跳过 ——
        // 结果就是「模型就绪了但一条向量都没有」。0.12.0 第一版就是这么翻的。
        try { build(); } catch { /* 建不出来就让后面按需编码 */ }
        const evs = (cachedCluster && cachedCluster.events) || [];
        return embedder.encode(
          evs.map((e) => ({ key: (e.ids && e.ids[0]) || '', text: (e.texts || []).join('\n') })),
        );
      })
      .then((n) => {
        if (n) {
          embedder.save();
          console.log(`[memory-curve] 语义向量就绪：新编码 ${n} 条，缓存共 ${embedder.size} 条`);
        }
      })
      .catch(() => { /* 任何失败都不影响主链路 */ });
  }

  // schema 是第一道闸，这里是第二道 —— NaN / Infinity 都能穿过 typeof 检查
  // （typeof NaN === 'number'），得用 Number.isFinite 才算数。
  // cap 默认 200 是给 maxL1/2/3 的上限；maxThreads 的 schema 上限是 20，
  // 走兼容通道时不能让它放大到 200（那会多注入 180 行主题线）。
  const num = (v, d, cap = 200) => (Number.isFinite(v) ? Math.max(0, Math.min(cap, v)) : d);
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
  // 缓存键带上会影响渲染的四个配置值。
  // 注意：**只有 memoryDir 标了 .volatile()**，maxL1/maxL2/maxL3/maxThreads 都没有 ——
  // 它们在 apply() 里被 num() 固化成常量，改了要重新 apply 才生效。
  // 键里带上它们不是为了支持热改，而是避免同一进程内多套配置互相读到对方的旧文本
  // （比如测试里换 config 重跑 apply）。
  // 只按时间缓存的话，3 秒内把 maxL1 从 12 改成 3 看不到任何变化，
  // 只有等采集器落盘触发 dropReadCache 才生效 —— 调参/测试时会以为「改了没反应」。
  const readKeyOf = () => `${maxL1}|${maxL2}|${maxL3}|${num(config.maxThreads, MAX_THREADS, 20)}`;
  let readCache = { at: 0, key: '', text: '' };
  // 采集落盘后立刻作废缓存。函数声明有提升，onDirty 里可以提前调用。
  function dropReadCache() { readCache = { at: 0, key: '', text: '' }; }
  const read = () => {
    // 短周期复用：DSH 每一步都会重新组装系统提示，一次修复里连续几次工具调用
    // 会各自触发一次完整重算（指纹 + 145 事件分级 + 渲染，实测约 27ms）。
    // 3 秒内直接返回上一份结果，自动采集新写入最多延迟这么久才反映到索引里。
    const nowMs = Date.now();
    const readKey = readKeyOf();
    if (readCache.text && readCache.key === readKey && nowMs - readCache.at < READ_TTL) return readCache.text;
    try {
      // 构建与渲染共用同一个 now：各取一次的话，跨午夜那一瞬间分级算的「距今」
      // 和渲染算的「今天/昨天」会落在两天上，出现「今天(11-14)」这类自相矛盾。
      const { entries, events, graded, threads } = build(nowMs);
      const body = renderForPrompt(graded, {
        maxL1, maxL2, maxL3,
        maxThreads: num(config.maxThreads, MAX_THREADS, 20),
        threads,
        now: nowMs,
      });
      const c = {};
      for (const g of graded) c[g.level] = (c[g.level] || 0) + 1;
      const idx = dayIndex(graded);
      // ── 注入体积（0.15.0 收紧）──────────────────────────────────────
      //
      // 这份文本**每 step 都要付一次 token**（DSH 每步重新组装系统提示，
      // 而 context.text 是函数 —— 这不是 bug，是它必须每次给出最新内容）。
      //
      // 0.14.4 实测 2694 字符 ≈ 1684 token。有人指出这个成本太高，是对的：
      // 注入越多 → 上下文越快撑满 → 压缩越勤 → 旧内容越早被压掉，
      // **一个号称解决记忆的工具反而加速了记忆被压掉**。
      //
      // 所以这里只留「路标」，不留内容：
      //   · 路径全去掉（模型不需要知道文件在哪，它只需知道调哪个工具）
      //   · 查法压成两行（原来七行，其中五行是解释，模型读一次就懂）
      //   · 天数 10 → 5，L2 20 → 8，L3 8 → 3
      //   · 标题截断 42 → 32 字符
      //
      // 检索能力**一点没减**：memory_search 仍然扫全部 3400 条原文。
      // 砍掉的只是"眼前摆多少条线索"，不是"能查到什么"。
      const text = [
        `【记忆索引】${entries.length} 条 / ${events.length} 事件　L1 ${c.L1 || 0}·L2 ${c.L2 || 0}·L3 ${c.L3 || 0}·L4 ${c.L4 || 0}·L5 ${c.L5 || 0}`
          + (collectorStatus?.lastError ? `　采集待重试：${String(collectorStatus.lastError).slice(0, 80)}` : ''),
        '',
        '【最近几天】',
        idx,
        '',
        '查法：摘要 memory_curve_day(日期)；查术语/偏移/文件名用 memory_search(词) 全流水搜；原文 memory_curve_raw(id) 或 memory_curve_raw(event:"e_日期_时分")。',
        '回答涉及记忆必须带 id 或日期；没查到就说没查到，不许编；冷/档也要查，不只看热的。',
        '',
        body || '（暂无高留存事件）',
      ].join('\n');
      readCache = { at: nowMs, key: readKey, text };
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
        // 描述里写了「条数/事件数/分级/关键主题」，就真的给出来。
        // 只列日期等于让调用方自己再读一遍摘要，白跑一次工具。
        const lines = days.map((day) => {
          const digest = readDigest({ digestDir: digestDir(), day }) || '';
          const head = digest.match(/^# .*?·\s*(\d+) 条 \/ (\d+) 事件/m);
          const grade = digest.match(/^分级：(.+)$/m)?.[1]?.trim() || '—';
          // 主题词是二元切片的碎片（「题线、主题、公式」），对人不友好。
          // 优先用当天第一个事件的首句，那才是「那天在干什么」。
          const topic = (digest.match(/^- 开头：(.+?)　\[/m)?.[1]
            || digest.match(/^主题：(.+)$/m)?.[1]
            || '—').trim().slice(0, 40);
          const count = head ? `${head[1]}条 ${head[2]}事件` : '摘要缺失';
          return `- ${day}　${count}　${grade}　${topic}`;
        });
        return { text: `共 ${days.length} 天：\n` + lines.join('\n') };
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

    // 搜索命中 = **弱提取**：看到了摘要片段，但没有完整回忆。给 0.4 的权重
    // （读原文是 1.5，见 access.js 的 touch 注释）。
    //
    // 以前 search 完全不记访问 —— 等于「搜到过」对记忆强度毫无影响，那不是记忆。
    // 但也不能给满分：扫到一行摘要和真把原文读出来，巩固效果差一个量级
    // （testing effect：提取练习 vs 重读）。
    if (r.total) {
      const seenIds = [...new Set((r.hits || []).flatMap((h) => h.ids || []))];
      if (seenIds.length) touch(accessFile(), seenIds, 'search:' + pat, 0.4);
    }
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
        // assertDay 会对手误格式抛 TypeError；这里转成提示，别把异常冒给模型。
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          return { text: `日期要写成 YYYY-MM-DD（收到 ${JSON.stringify(day)}），例如 2026-11-09` };
        }
        const t = readDigest({ digestDir: digestDir(), day });
        // 一句话回顾（0.13.0）：把当天的摘要「重述」成一段连贯的话，而不是罗列条目。
        // 纯算法重组 —— 所有词都来自真实字段，一个都不编（见 narrate.js 的注释）。
        const withNarr = (txt) => {
          if (!txt) return txt;
          try {
            const g = build();
            const n = narrateDay(g.graded, clusterThreads(), day);
            return n ? `${txt}\n\n【一句话回顾】\n${n}` : txt;
          } catch {
            return txt;                     // 重构失败不能拖累摘要本身
          }
        };
        if (t) return { text: withNarr(t) };
        // 摘要没生成过就现做 —— 只补这一天。不传 days 会把全部日子的摘要
        // 重算一遍（全量聚类 + 全量写盘），查一个不存在的日期就白烧一次。
        try { buildDailies({ memDir: memDir(), digestDir: digestDir(), days: [day] }); } catch {}
        const t2 = readDigest({ digestDir: digestDir(), day });
        return { text: withNarr(t2) || `没有 ${day} 的摘要。可用 memory_curve_days 看有哪些天。` };
      },
      presentCall: (a) => ({ card: 'generic', title: '查摘要', kind: 'other', rawInput: a?.day || '' }),
    }));

    // ── 3. 回原文（可按关键词过滤）
    disposers.push(tools.register({
      name: 'memory_curve_raw',
      description: [
        '回查原始记忆。三种用法，优先用 id：',
        '  ① id：某个 memory_id（如 m_20261109_a1b2c3），精确取那一条；',
        '  ② ids：一串 memory_id，批量取；',
        '  ③ day + pattern：按日期 + 关键词/正则模糊找。',
        '摘要里每条事实后面都带 id，顺手抄过来查，别凭摘要猜。',
      ].join('\n'),
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', description: '单个 memory_id，形如 m_20261109_a1b2c3' },
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
          touch(accessFile(), [id], 'raw:id', 1.5);
          // 读原文 = 真正的「提取」。这一步的副作用是双向的：压住竞争者（RIF）、带出关联。
          const side = afterRetrieval([id]);
          return { text: `# ${one.id}　${one.day}\n\n${one.text}${renderRelated(side.related)}` };
        }
        // ② 批量 ids（元素可以是单条，也可以是 m_a..m_b 范围）+ 可选 pattern 二次过滤
        if (Array.isArray(args?.ids) && args.ids.length) {
          let ids = [];
          // 单项失败不能拖垮整批：以前 expandRange 一抛错就 `return` 整个结果，
          // 用户传 ["m_x", "m_a..m_b（两端哈希，无法展开）", "event:e_…"] 时，
          // 第一和第三条已经解析出来的全部作废，只拿到一句错误。
          // 现在收集错误、跳过该项继续，最后把正常结果和跳过说明一起给。
          const errs = [];
          for (const spec of args.ids) {
            const s2 = String(spec || '').trim();
            // event:e_20261109_1255 -> 从 ids.json 取完整数组。
            // 摘要里标 +N（不连续）的事件只能这样取，靠范围展开会拉进不属于它的条目。
            if (s2.startsWith('event:')) {
              const r2 = eventIds({ digestDir: digestDir(), eventKey: s2.slice(6) });
              if (!r2) { errs.push(`找不到事件 ${s2}`); continue; }
              ids = ids.concat(r2.ids);
            } else {
              // expandRange 会对真正的区间抛错（内容哈希无法展开），
              // 这里转成给人看的提示，不让它冒到工具层当异常。
              let add = [];
              try { add = expandRange(s2); }
              catch (e) { errs.push(`跳过 ${s2}：${e?.message ?? e}`); add = null; }
              // expandRange 对「格式就不对」的串不抛错，直接返回空数组（'bad'、'm_abc'、
              // 抄错的哈希、空串都走这条）。不单独记一笔的话，混在批次里的手误 id
              // 既取不到内容、也不进「已跳过 N 项」，用户完全无感。
              if (add && !add.length && s2) errs.push(`无法识别的 id：${s2}`);
              if (add) ids = ids.concat(add);
            }
          }
          // 一条都没解析出来时，把错误原样给人看，别退化成「范围内没命中」
          if (!ids.length) {
            return { text: errs.length ? errs.join('\n') : 'ids 里没有可用的条目' };
          }
          const warn = errs.length ? `\n\n（已跳过 ${errs.length} 项：${errs.join('；')}）` : '';
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
          if (!pool.length) return { text: `范围内没命中${pat ? `「${pat}」` : ''}（检查 ${ids.length} 条）${warn}` };
          const r = readByIds({ memDir: memDir(), ids: pool, maxChars });
          // 只记「真正进入上下文」的那几条。以前用 pool.slice(0, r.found)：
          // pool 里夹着缺失 id 时，被记成「查过」的是缺失项，真正返回的后一条没记，
          // 截断时（found < pool.length）同样错位。readByIds 现在把实际取到的 id 回传。
          const picked = [...new Set(r.picked)];
          touch(accessFile(), picked, 'raw:ids', 1.5);
          const side = afterRetrieval(picked);
          const head = pat ? `范围内命中 ${pool.length}/${ids.length} 条` : `共 ${r.total} 条`;
          const tail = r.found < r.total ? `\n\n（本次只取到 ${r.found} 条，受 maxChars=${maxChars} 限制；要更多就加大 maxChars 或用 pattern 缩小）` : '';
          return { text: `# ${head}\n\n${r.text}${tail}${warn}${renderRelated(side.related)}` };
        }
        // ③ 日期 + 关键词
        const day = String(args?.day || '').trim();
        if (!day) return { text: '要给 id、ids 或 day 之一' };
        const r = grepDay({ memDir: memDir(), day, pattern: args?.pattern, maxChars });
        if (!r) return { text: `没有 ${day} 那天完整流水` };
        // 按关键词模糊查也记访问：命中的条目算被用过
        try {
          const hitIds = [...r.text.matchAll(/m_[0-9]{8}_[0-9a-f]{6}/g)].map((x) => x[0]);
          if (hitIds.length) touch(accessFile(), [...new Set(hitIds)], 'raw:day:' + (args?.pattern || ''), 1.5);
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

    // ── 6. 手动沉底 / 捞回（0.17.0）
    //
    // 记忆插件本来**自己**决定什么重要（按 R、S、显著性、未完成度排）。
    // 但有些事只有当事人知道：某件事彻底结了、某个方向不做了、某段对话不想再被提起。
    // 自动策略判断不出来，只能人工标。
    //
    // 沉底**不删任何东西**：原文还在 md 里，`memory_search` 照样搜得到，
    // `memory_curve_raw` 照样取得出。唯一变化是**不再出现在注入里**，不占那份 token。
    //
    // 这是「想不起来」和「忘了」的区别 —— 人也没法真正删记忆，只能让它沉下去；
    // 沉下去的东西可以被线索勾回来。
    //
    // 也是 MemGPT 那套「模型自己控制上下文」里真正能用的部分：
    // 不是改写历史（DSH 不给权限，0.16.4 验过了），而是**改一下排序权重**。
    disposers.push(tools.register({
      name: 'memory_shelve',
      description: '让某条记忆沉底——不再出现在系统提示里（省 token），但 memory_search 仍然搜得到。传 off:true 捞回来。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          targets: {
            type: 'array',
            items: { type: 'string' },
            description: 'memory id（m_20261122_abcdef）或事件键（e_20261122_1530）',
          },
          indices: {
            type: 'array',
            items: { type: 'integer' },
            description: '事件序号（memory_curve_show 里显示的 #N）。跟 targets 二选一或并用。',
          },
          off: { type: 'boolean', description: 'true = 捞回来，留空/false = 沉底' },
          reason: { type: 'string', description: '为什么沉（只留给人看，不参与计算）' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
        render: (_a, v) => [{ type: 'text', text: v.text }],
      },
      async execute(args) {
        const want = Array.isArray(args?.targets) ? args.targets.map((x) => String(x)).filter(Boolean) : [];
        const idxs = Array.isArray(args?.indices) ? args.indices.filter((x) => Number.isInteger(x)) : [];
        if (!want.length && !idxs.length) {
          return { text: '没给 targets 也没给 indices。\n可以用 indices: [75]（memory_curve_show 里的 #N），或 targets: ["m_20261122_abcdef"]。' };
        }
        const ids = [];
        let keyCount = 0;
        let idxCount = 0;
        // 序号优先：它比事件键好用 —— 事件键里的时分跟 show 显示的时间不是同一个
        // （键用的是事件某处的钟点，不是 startAt），照着 show 抄会解析不出来。
        if (idxs.length) {
          const { graded } = build();
          for (const i of idxs) {
            const g = graded.find((x) => x.idx === i);
            if (g && Array.isArray(g.ids) && g.ids.length) { ids.push(...g.ids); idxCount++; }
          }
        }
        for (const t of want) {
          if (t.startsWith('e_')) {
            // **别切前缀** —— eventIds 的正则要求完整 `e_YYYYMMDD_HHMM`。
            // 0.17.1 这里写的是 t.slice(2)，把 `e_` 切掉了，于是永远解析不出来，
            // 而且报错信息还把责任推给用户（"事件键形如 e_..."），实际给的就是对的。
            const r = eventIds({ digestDir: digestDir(), eventKey: t });
            if (r && Array.isArray(r.ids) && r.ids.length) { ids.push(...r.ids); keyCount++; }
          } else {
            ids.push(t);
          }
        }
        if (!ids.length) {
          return { text: `一个 id 都没解析出来（targets: ${want.join(', ') || '空'} / indices: ${idxs.join(', ') || '空'}）\n可以用 indices: [75]（memory_curve_show 里的 #N）。` };
        }
        const off = args?.off === true;
        const r = shelve(accessFile(), ids, !off, args?.reason || '');
        return {
          text: `${off ? '捞回' : '沉底'} ${r.shelved} 条`
            + (idxCount ? `（${idxCount} 个序号）` : '')
            + (keyCount ? `（${keyCount} 个事件键展开）` : '')
            + `\n${off ? '它们会重新出现在注入里。' : '它们不再出现在注入里，但 memory_search 仍能搜到原文。'}`,
        };
      },
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
