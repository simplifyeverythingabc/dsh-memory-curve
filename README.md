# dsh-memory-curve

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的记忆插件：**按艾宾浩斯遗忘曲线给历史事件分级**，重要的一直挂在上下文里，不重要的沉到文件里但随时能翻回来。

解决的问题：聊了几十上百轮之后，上下文早被截断，模型不记得之前干过什么。全塞回去会撑爆窗口，全不塞又会重复踩坑。

这个插件的做法是——**只往上下文里放"还该记得的"**，剩下的留在磁盘上，用工具按需取。

---

## 它长什么样

装上之后，每轮对话的系统提示里会多出这么一段：

```
【记忆事件索引 · 按遗忘曲线】
完整流水 D:\memory（1488 条 / 96 事件）
分级：T1 22　T2 10　T3 8　T4 6　T5 50

【最近几天 · 定位用】
- 2026-03-15　222条  8事件 T1×8　把 nacos 的配置挪到本地文件里…
- 2026-03-14　314条 12事件 T1×10 T2×2　先看日志再改代码，别猜…

【T1 核心事件 · 常驻】
- 03-13 28条　连接池上限调到 200 之后超时确实少了…
- 03-14 28条　那个 401 是网关的 header 没透传…
...
```

**1488 条对话压成 400 来字**，占的上下文不到千分之一。

## 跑一个小例子

三天假数据（11 条消息），造完之后跑一遍分级，实际输出是这样：

```
条目 11　事件 5

【T3 活跃事件 · 只留索引】
- 03-13 3条　连接池上限调多少合适
- 03-14 2条　网关那边 401 了，本地是好的
- 03-14 2条　加了，通了
- 03-15 2条　nacos 配置想挪到本地文件

【更早 · 按 S 补位（不限等级）】
- 03-13 3条　连接池上限调多少合适
- 03-13 2条　果然少了，报错从每小时十几次降到两次
- 03-14 2条　网关那边 401 了，本地是好的
- 03-14 2条　加了，通了
```

注意几点：

- **没有 T1/T2**：只有三天数据，`S` 值还不够（T1 要 `S≥6`）。数据攒够了才会往上升
- **T3 和「更早」有重复**：前者是等级分层，后者是兜底补位。T1/T2 空的时候两段会重叠，这是正常的
- **每行只留首句**：正文永远在磁盘上，`memory_curve_raw` 按 id 取

真实跑起来（几百条 / 几十天）会是四段齐全的样子，见本文开头的示例。

---

## 三层结构

```
┌─ 第一层：完整流水（永久，一字不删）
│    ~/.dsh/memory/2026-11-10.md      或 D:\memory\2026-11-10.md
│    每行一条消息，带内容哈希锚点
│
├─ 第二层：每日摘要（自动生成）
│    <DSH_HOME>/memory-notes/_digest/2026-11-10.md
│    事件清单 + 首尾句 + 关键词，还有 .ids.json 索引
│
└─ 第三层：注入上下文（每轮重算）
     T1/T2 事件标题 + 最近几天速览
```

**检索链**：上下文看到线索 → `memory_curve_day` 读摘要 → `memory_curve_raw` 回原文。

---

## 安装

```bash
# 1. 进到你的 DSH profile 目录
cd ~/.dsh/profiles/desktop

# 2. 装插件
pnpm add file:./path/to/dsh-memory-curve

# 3. 在 cordis.patch.yml 里加一行
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: memory-curve
      name: dsh-memory-curve
      config:
        maxT1: 12      # T1 最多列几条
        maxT2: 20      # T2 最多列几条
        maxT3: 8       # T3 只留索引
```

重启 DSH，看到 `[memory-curve] 自检通过` 就成了。

---

## 配置记忆目录

四个入口（插件 + 三个采集/校验脚本）走**同一个函数** `src/paths.js` 的 `resolveMemDir()`，按优先级：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `DSH_MEMORY_DIR` | 环境变量。四边都认，最省事 |
| 2 | `MEMORY_GALAXY_DIR` | 兼容旧名 |
| 3 | `D:\memory` | Windows 老位置，**存在才用** |
| 4 | `<DSH_HOME>/memory` | 跨平台默认 |

**这四条对插件和三个脚本完全一样** —— 不会再出现「插件读 A、脚本写 B」。

### 推荐：设环境变量

```powershell
# Windows
setx DSH_MEMORY_DIR "D:\memory"
```

```bash
# Linux / macOS
export DSH_MEMORY_DIR="$HOME/memory"
```

**设完要重开命令行和 DSH**（`setx` 只影响新进程）。

想搬目录就用这条，四边一起跟着变。

### 或者在 profile 里覆盖（只影响插件）

编 `~/.dsh/profiles/desktop/cordis.patch.yml`，末尾加：

```yaml
- id: memory-curve
  name: dsh-memory-curve
  config:
    memoryDir: D:\memory
```

**注意不要写 `- insert:`** —— 那会让插件加载两次、id 重复，配置编辑器会直接过滤掉它。要覆盖已有条目就用上面这种不带 `insert` 的形式。

**这条路只影响插件读，不影响三个脚本。** 脚本不读 `cordis.patch.yml`。要搬目录请用环境变量，别用这条。

### 为什么没有设置界面

试过，做不出来。

DSH 的 `configForms` 服务对本插件返回的 `form` 对象是空壳 —— 只有 `unsubscribe`，没有 `mutate` / `getSnapshot`，拿不到写入通道。同目录的 `web-search` 能改是因为它的 client bundle 走了内部路径，外部插件复现不了。

**放弃面板后反而更清爽**：少一个 client bundle，少一层出错的可能，环境变量本来就更适合这种「一次配好不再动」的东西。

## 装完是空的，得先喂数据

**插件只负责「读」，不负责「采集」。** 装上之后索引是空白的，六个工具都返回"没有记忆"，这是正常的。

流水得从 DSH 自己的会话日志生成：

```bash
node tools/memory-notes.mjs
```

它会读 `<DSH_HOME>/sessions/`，把每天的对话写成 `<内存目录>/YYYY-MM-DD.md`。

**内存目录怎么定**（`tools/memory-notes.mjs` 和 `src/index.js` 用同一套规则）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `DSH_MEMORY_DIR` | 推荐显式设成这个 |
| 2 | `MEMORY_GALAXY_DIR` | 早期从 dsh-memory-galaxy 借的变量，保留兼容 |
| 3 | `<DSH_HOME>/memory` | 默认值 |

默认 `<DSH_HOME>` 是 `~/.dsh`。所以什么都不设的话，流水会落在 `~/.dsh/memory/`。

**为什么默认不往 `D:\memory` 写**：某些环境下 node 进程被限制，写非系统盘会 `EPERM`——实测 DSH 自带的 node 运行时就是这样，同一目录下 PowerShell 却能正常写。与其赌，不如默认走一定可写的位置。真要放 D 盘，显式设 `DSH_MEMORY_DIR=D:\memory`。

脚本跑之前会先探测目标目录可不可写，不可写就当场报错并给出换目录的建议，不会跑到一半才崩。会话日志目录不存在时也只是提示一句然后正常退出（退出码 0），不抛异常。

**为什么不自动采集**：记忆是私密的。采哪些会话、留多久、写到哪里，应该由你决定，不该由插件替你决定。

**为什么插件不自己建目录**：`readEntries()` 第一行就是 `if (!existsSync(memDir)) return []`。目录不存在就当没有记忆，不报错也不创建。这样插件不会在你的磁盘上悄悄留下东西。

**跑完之后**：索引会在下一步对话开始时出现。想立刻看到结果就重启一次 DSH。

### 手动造流水也行

格式很简单，手写、脚本生成、从别的工具导都可以：

```markdown
2026-01-15 10:00 ［用户］ <!-- m_20260115_a1b2c3 -->
连接池超时怎么排查

2026-01-15 10:01 ［助手］ <!-- m_20260115_d4e5f6 -->
先看 maxWait 和数据库的 wait_timeout，两边对不上就会超时。
```

- 行首：`YYYY-MM-DD HH:MM ［说话人］`
- 锚点：`<!-- m_YYYYMMDD_<6位十六进制> -->`，正文 SHA1 前六位
- 正文：随便写，多行也行
- 文件名：`YYYY-MM-DD.md`，一天一个
## 工具

装好后模型能用这些工具（你也可以在对话里直接让它调）：

| 工具 | 作用 |
|---|---|
| `memory_search` | 全文搜流水，支持关键词和正则 |
| `memory_curve_day` | 读某天的摘要 |
| `memory_curve_raw` | 按 id / 事件键 / 范围取原文 |
| `memory_curve_days` | 列出所有有记忆的日期 |
| `memory_curve_show` | 看当前分级 |
| `memory_curve_build` | 重建摘要和分级 |

---

## 分级怎么算的

**强度 S**（这条记忆有多结实）：

```
S = ln(1+条数) × (1 + 0.35·ln(1+跨度天数)) × (1 + 密度/60) × accessBoost
```

**留存 R**（到现在还记得多少）：

```
R = exp(−距今小时 ÷ (S × 24))
```

**分级**（从上往下第一个匹配）：

| 等级 | 条件 | 进上下文吗 |
|---|---|---|
| T1 | R ≥ 0.72 且 S ≥ 6 | 是，常驻 |
| T2 | R ≥ 0.5 且 S ≥ 4 | 是 |
| T3 | R ≥ 0.3 | 只留标题 |
| T4 | R ≥ 0.12 | 只留索引 |
| T5 | 其余 | 不进上下文 |

**但是**——纯粹的"越新越重要"会漏掉低密度但关键的日期。所以加了两条补丁：

1. **时间桶配额**：今天 / 本周 / 更早 各保留 4 个，桶内按 S 排
2. **历史补位**：不限等级按加权 S 补位，聊天类降权到 0.25、技术密度高的加权

这样"三天前那个只有两条消息的调试记录"不会因为条数少被彻底埋掉。

**"遗忘"的真实含义**：T4/T5 不进上下文，但**文件永远保留**，`memory_search` 随时能搜到。

---

## JavaScript API

`src/digest.js` 导出的函数**统一用对象参数**，不位置传参。这样加参数不会打断已有调用，也不会出现「第一个参数到底是目录还是日期」这种歧义。

```js
import {
  readEntries, clusterEvents, gradeEvents, renderForPrompt,
} from './src/events.js';
import {
  buildDailies, readDigest, listDays, grepDay,
  readById, readByIds, searchAll, expandRange, eventIds, makeMatcher,
} from './src/digest.js';

const memDir = 'C:/Users/you/.dsh/memory';
const digestDir = 'C:/Users/you/.dsh/memory-notes/_digest';

const entries = readEntries(memDir);
const graded = gradeEvents(clusterEvents(entries));
const index = renderForPrompt(graded, { maxT1: 12, maxT2: 20, maxT3: 8 });

const days = listDays({ memDir, digestDir });                          // string[]
const md = readDigest({ digestDir, day: '2026-11-11' });              // string | null
const hits = searchAll({ memDir, pattern: '缓存', maxHits: 5, digestDir });

const one = readById({ memDir, id: 'm_20260115_a1b2c3' });            // { id, day, text } | null
console.log(one.text);
```

### 参数表

| 函数 | 参数 | 返回 | 注意 |
|---|---|---|---|
| `buildDailies` | `{ memDir, digestDir }` | `{ written, total, events }` | 读 memDir，**写** digestDir |
| `readDigest` | `{ digestDir, day }` | `string \| null` | 第一个字段是**摘要目录** |
| `listDays` | `{ memDir, digestDir }` | `string[]` | 两个都是目录，任一传 `null` 就跳过 |
| `grepDay` | `{ memDir, day, pattern, maxChars }` | `string` | — |
| `readById` | `{ memDir, id }` | `{ id, day, text } \| null` | **返回对象**，`.text` 是正文 |
| `readByIds` | `{ memDir, ids, maxChars }` | `{ text, missing }` | — |
| `searchAll` | `{ memDir, pattern, maxHits, window, digestDir, stateMap }` | `{ hits, total, mode }` | 其余都进 `opts` |
| `expandRange` | `spec`（字符串） | `string[]` | 只接 `m_a..m_b`，**不接事件键** |
| `eventIds` | `{ digestDir, eventKey }` | `{ ids, count, level, day } \| null` | 事件键走这个 |
| `makeMatcher` | `pattern`（字符串） | `{ re }` | 单参数，保持位置传参 |

`expandRange` 和 `makeMatcher` 只有一个参数，没有歧义，保持位置传参。

### 传错会怎样

用老的位置传参调新签名，会立刻抛 `TypeError` 并告诉你正确写法：

```js
readDigest(digestDir, '2026-11-11')
// TypeError: readDigest 的参数改成了对象形式：readDigest({ digestDir, day })
```

**不做静默兼容**——两套签名并存会让人猜不透当前该用哪个，错误也更容易藏在深处。

### 为什么返回对象而不是字符串

`readById` 返回 `{ id, day, text }` 而不是直接返回正文：

- `day` 是这一天，调用方经常要按天分组
- `id` 是回填给 `access.json` 做访问计数用的
- `text` 里**含首行**（时间 + 说话人），原样取出来就能直接展示

只返回 `text` 的话，前两样每次都得重新解析。
## 验证它能不能跑

仓库里带了个自检脚本，不需要 DSH 在运行，也不碰你的真实数据：

```bash
node tools/selftest.mjs
```

它会在临时目录造两份最小流水（5 条消息），然后：

- 从零 import 插件，检查 `inject` 声明
- 传一个最小 `ctx` 调 `apply()`，确认 6 个工具都注册上了
- 求值 `context.text()`，确认能输出索引
- 挨个调 6 个工具，确认都能返回内容

全过会打印 `✓ 全部通过 —— 干净环境可跑` 并返回 0。

**临时目录不可写时**（某些受限环境），指定一个可写位置：

```bash
MC_SELFTEST_ROOT=/path/to/writable node tools/selftest.mjs
```

注意这只是**模拟宿主**——用最小的 `ctx` 对象替代真实的 DSH。它能证明插件本身逻辑没问题，但证明不了跟真宿主的接口完全对得上。真装一遍才算数。
## 它依赖宿主的哪些能力

自检脚本里的「假宿主」不是随手写的空壳，校验规则全部照抄 Cordis 和 DSH 的真实实现。下面这些是插件的硬依赖，缺一个就跑不起来：

**`ctx.effect(execute, label = 'anonymous')`**

`execute` 无参数调用，返回值可以是四种之一：

```ts
type Disposable = () => any
type SyncEffect  = Disposable | Iterable<Disposable>
type AsyncEffect = Promise<Disposable> | AsyncIterable<Disposable>
```

Cordis 把它们全部收进 `disposables`，卸载时**反序执行**，而且每个 disposer 只跑一次（内部有 `disposing` 标志）。调用前会 `assertActive()`，fiber 处于 `UNLOADING` 时直接抛 `CordisError('INACTIVE_EFFECT')`。

本插件在这个通道里注册两样东西：`memory-curve-index` 这个 context，和一个兼容用的 `memory_curve` 变量。返回的都是单个 disposer 函数。

**`ctx.systemPrompt.context(definition)`**

硬校验，缺一个就抛 `TypeError`：

| 字段 | 要求 |
|---|---|
| `order` | 必须是有限数字（`Number.isFinite`） |
| `name` | 必须是非空字符串 |
| `text` | 字符串或函数；函数每步重新求值 |
| `interpolate` | 设 `false` 绕过变量解析 |

本插件用 `order: 900`，`text` 是函数（每步重读磁盘），`interpolate: false`。

**`ctx.tools.register(definition, options)`**

同样硬校验：

| 检查 | 后果 |
|---|---|
| `output` 必须是对象 | 否则 `TypeError` |
| `output.render` 必须是函数 | 否则 `TypeError` |
| `output.presentationMeta` 若存在必须是函数 | 否则 `TypeError` |
| `name` 必须是非空字符串 | 否则 `TypeError` |

返回的是「注销这个工具」的 disposer。第二个参数 `options.when` 是逐步骤的启用条件，本插件没用到。

### 绝对不要写 export default

```js
// ✗ 这样写会让 Config 凭空消失
export default { name: 'memory-curve', inject, apply };
```

Cordis Loader 的归一化逻辑：

```js
unwrapExports(exports) {
  exports = exports.default ?? exports;   // 有 default 就折叠成它
  ...
}
```

一旦提供 `default`，整个命名空间被折叠成那个对象，**`Config` 作为命名导出直接丢失**。后果是链条式崩塌：

```
registry.plugin() 拿到 plugin.Config === undefined
  -> fiber.runtime.Config === undefined
  -> dsh-settings 的 describe() 判定 schema === undefined 并跳过
  -> 设置界面永远 status=unavailable / revision=undefined，保存被拒
```

而且报错信息完全不指向这里。只用命名导出就没事。
**插件本体的三个导出**

| 导出 | 必需 | 说明 |
|---|---|---|
| `name` | 建议 | Cordis 用它做 fiber 标签，缺了日志里看不到是谁 |
| `inject` | 是 | 声明依赖的服务，本插件要 `['systemPrompt', 'tools']` |
| `apply` | 是 | `apply(ctx, config)`，插件入口 |
## 检索质量基准

`tools/bench.mjs` 自带一份夹具（四天假对话，一个 JDBC 连接池排查过程），不读任何真实数据，clone 下来直接就能跑。

```bash
node tools/bench.mjs
```

33 条查询分七类，每类打一种检索难点：

| 类型 | 测什么 | 当前 |
|---|---|---|
| `term` | 精确术语，不许被分词拆散 | 8/8 |
| `cn` | 中文短语，二元切词的死角 | 6/6 |
| `multi` | 多词组合，coverage 加权 | 5/5 |
| `cross` | 跨天主题 | 3/3 |
| `evo` | 演化修正，必须命中最后那版 | 3/3 |
| `hist` | 正确答案只命中一个词 | 5/5 |
| `neg` | 不存在的词，不许乱命中 | 3/3 |

判定按优先级：`expectZero` → `anchor`（片段里含这句话）→ `want`（命中指定 id）→ `wantDay`（至少命中那天）。

**`anchor` 用的是内容片段而不是 id**，因为 id 是内容哈希，重建流水时不会漂移，但换一行文字就变了。锚点跟着内容走，改夹具时只需同步改锚点，永远是自洽的。

**还有个更诚实的数字**：脚本最后会打印「精确率」（返回片段里含查询首词的比例）。当前夹具上是 **70.5%**。也就是说即使每条查询都能捞到正确答案，**返回的前十条里仍有约三成片段跟查询词不完全对得上** —— 这是加权 OR 的固有代价，也是下一步要改的地方。

夹具文本改了要同步改锚点，否则会出现「查询词根本不在答案里」的假失败。这个坑踩过：最初写「超时 怎么 排查」配锚点「先确认 wait_timeout」，而那句话里压根没有「超时」二字 —— 疑问词被剥离后只搜「超时」，永远召回不到。**测试写错比代码写错更隐蔽。**
## 已知限制

**一、Windows 特有**

流水路径默认会先试 `D:\memory`（历史原因），不存在才用 `<DSH_HOME>/memory`。跨平台请显式设 `DSH_MEMORY_DIR`。

**二、需要 DSH 0.2.x**

用了 `ctx.systemPrompt.context()` 这个官方 API。注册时**必须**设 `interpolate: false`，否则记忆内容里出现 `{{` 会被当成提示变量解析直接抛错。

**三、内容哈希的两个边界**

- 同一段文字说两遍 → 只存一条（哈希相同）
- 改一个错别字 → 变成新条目（哈希变了）

第二条是接受的代价：目前流水是只追加的，没有"修订已有条目"的语义。

**四、检索质量**

`memory_search` 用的是加权 OR + coverage 打分。**已知的问题**：当正确答案只命中一个词、而错误答案命中了两个词时，正确答案会排在后面。

实测例子：搜「缓存 失效 排查」，一句"别用缓存了"（命中2词）排在真正的排查记录（只命中"缓存"1词）前面。

改法在计划里：IDF 加权 + 整词匹配优先 + 内容类型信号，三件事一起做。单上任何一个都会引入新的偏斜。

---

## 目录

```
dsh-memory-curve/
├── src/
│   ├── index.js      插件入口：6 个工具 + context 注入
│   ├── events.js     聚类、分级、打分、渲染
│   ├── digest.js     搜索、排序、按 id 取文
│   └── access.js     访问计数、冷热状态
├── tools/
│   ├── memory-notes.mjs    会话日志 → 流水
│   ├── build-dailies.mjs   流水 → 每日摘要
│   └── verify-ids.mjs      完整性校验
├── cordis.patch.yml
└── package.json
```

---

## License

MIT