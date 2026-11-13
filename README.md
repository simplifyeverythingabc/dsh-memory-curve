# dsh-memory-curve

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的记忆插件：**按艾宾浩斯遗忘曲线给历史事件分级**，重要的一直挂在上下文里，不重要的沉到文件里但随时能翻回来。

解决的问题：聊了几十上百轮之后，上下文早被截断，模型不记得之前干过什么。全塞回去会撑爆窗口，全不塞又会重复踩坑。

这个插件的做法是——**只往上下文里放"还该记得的"**，剩下的留在磁盘上，用工具按需取。

---

## 它长什么样

装上之后，每轮对话的系统提示里会多出这么一段：

```
【记忆事件索引 · 按遗忘曲线】
完整流水 <记忆目录>（1488 条 / 96 事件）
分级：L1 22　L2 10　L3 8　L4 6　L5 50

【最近几天 · 定位用】
- 2026-03-15　222条  8事件 L1×8　把 nacos 的配置挪到本地文件里…
- 2026-03-14　314条 12事件 L1×10 L2×2　先看日志再改代码，别猜…

【L1 核心事件 · 常驻】
- 03-13 28条　连接池上限调到 200 之后超时确实少了…
- 03-14 28条　那个 401 是网关的 header 没透传…
...
```

**1488 条对话压成 400 来字**，占的上下文不到千分之一。

## 跑一个小例子

三天假数据（11 条消息），造完之后跑一遍分级，实际输出是这样：

```
条目 11　事件 5

【L3 活跃事件 · 只留索引】
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

- **没有 L1/L2**：只有三天数据，`S` 值还不够（L1 要 `S≥6`）。数据攒够了才会往上升
- **L3 和「更早」有重复**：前者是等级分层，后者是兜底补位。L1/L2 空的时候两段会重叠，这是正常的
- **每行只留首句**：正文永远在磁盘上，`memory_curve_raw` 按 id 取

真实跑起来（几百条 / 几十天）会是四段齐全的样子，见本文开头的示例。

---

## 三层结构

```
┌─ 第一层：完整流水（永久，一字不删）
│    <记忆目录>/2026-11-10.md         目录由 src/paths.js 统一解析
│    每行一条消息，带内容哈希锚点
│
├─ 第二层：每日摘要（自动生成）
│    <DSH_HOME>/memory-notes/_digest/2026-11-10.md
│    事件清单 + 首尾句 + 关键词，还有 .ids.json 索引
│
└─ 第三层：注入上下文（每轮重算）
     L1/L2/L3 事件段 + 最近几天速览 + 历史补位
```

**检索链**：上下文看到线索 → `memory_curve_day` 读摘要 → `memory_curve_raw` 回原文。

---

## 安装

用 DSH 的插件 / Bundle 安装入口安装这个包。这个入口会把包加入当前 profile 的 `dsh.profile.bundles`，然后读取包里的 `package.json`：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

推荐从 GitHub 安装：

```bash
dsh plugin --profile desktop add github:simplifyeverythingabc/dsh-memory-curve
```

本地开发目录可以把 GitHub 地址换成插件目录的绝对路径。也可以在 DSH 的插件管理界面里选择本地目录或 GitHub 来源安装。

**不要再手写 `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `- insert: id: memory-curve`。** Bundle 安装会自动应用包内的 `cordis.patch.yml`；再手写一条相同 id 会产生重复 entry，配置编辑器会过滤重复项。

如果只运行普通 `pnpm add`，它只安装依赖，不一定把包加入 DSH 的 bundle 选择列表；安装后要在 DSH 的插件 / Bundle 管理入口里选中它。

重启 DSH，确认日志出现：

```
[memory-curve] context 注册: interpolate=false
```

安装器显示 `application: applied` 后，重启一次；若安装器返回 `restart-required`，先完成重启再检查日志。加载失败或被 disabled 时不会出现这行日志，应先看安装器返回的诊断。

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

### 临时停用

在 profile patch 里加一个顶层覆盖条目：

```yaml
- id: memory-curve
  name: dsh-memory-curve
  disabled: true
```

这是 Loader 的条目级停用，重启后不注册任何工具、也不注入上下文。想恢复就删掉这条停用覆盖，或改成 `disabled: false`。
插件自身的 `config.disabled: true` 也支持停用，但如果覆盖 `config`，要重述完整 config，因为 Loader 对 config 是整体替换。

### 或者在 profile 里覆盖（只影响插件）

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，末尾加：

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

## 首次使用（四步）

**插件只负责读和检索，不负责自动采集。** 新用户在第一次采集前看到「（暂无高留存事件）」属于正常空索引，不是安装失败。

1. 安装 Bundle，重启 DSH，确认日志出现 `[memory-curve] context 注册: interpolate=false`。
2. 在插件包目录执行采集脚本：

   ```bash
   node tools/memory-notes.mjs
   ```

   如果你当前在 profile 目录，执行：

   ```bash
   node node_modules/dsh-memory-curve/tools/memory-notes.mjs
   ```

3. 采集器读取 `<DSH_HOME>/sessions/`，按下面的目录规则写入 `<记忆目录>/YYYY-MM-DD.md`。
4. 开始下一轮对话即可刷新索引；也可以重启 DSH，在启动时重建摘要。

已有有效流水的用户可以跳过第 2 步。会话目录不存在时采集器会提示后以退出码 0 结束，此时只是没有产生流水。

### 内存目录怎么定

`tools/memory-notes.mjs`、`tools/build-dailies.mjs`、`tools/verify-ids.mjs` 和插件都调用 `src/paths.js` 的同一个 `resolveMemDir()`：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `DSH_MEMORY_DIR` | 推荐显式设成这个 |
| 2 | `MEMORY_GALAXY_DIR` | 兼容旧名 |
| 3 | `D:\memory` | 仅 Windows，目录存在才沿用 |
| 4 | `<DSH_HOME>/memory` | 默认值 |

`<DSH_HOME>` 默认是 `~/.dsh`。未设置目录环境变量时，Windows 上已有 `D:\memory` 会被沿用；否则使用 `<DSH_HOME>/memory`。想固定位置请显式设置 `DSH_MEMORY_DIR`。

采集脚本会先探测目标目录是否可写，不可写就当场报错，不会静默改写到另一个目录。插件未配置 `config.memoryDir` 时，读取不存在的目录按空记忆处理；显式配置 `memoryDir` 时会尝试创建该目录。

Windows UNC 路径请用双反斜杠开头，例如 `\\server\share\memory`；这种输入规范化后保留 `//` 前缀。当前版本直接填写 `//server/share/memory` 会丢掉一个前导斜杠，配置时用前一种写法。

**为什么不自动采集**：记忆是私密的。采哪些会话、留多久、写到哪里，由你决定。

**跑完之后**：索引会在下一轮对话开始时出现。想立刻看到结果就重启一次 DSH。

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

**分级**（先把 S 四舍五入到 2 位、R 四舍五入到 3 位，再从上往下匹配第一个等级）：

| 等级 | 条件 | 注入方式 |
|---|---|---|
| L1 | R ≥ 0.72 且 S ≥ 6 | 独立事件段，受 `maxL1` 限制 |
| L2 | R ≥ 0.5 且 S ≥ 4 | 独立事件段，受 `maxL2` 限制 |
| L3 | R ≥ 0.3 | 独立事件段，受 `maxL3` 限制 |
| L4 | R ≥ 0.12 | 不单列等级段，但 7 天以上的事件可能进入历史补位 |
| L5 | 其余 | 不单列等级段，但 7 天以上的事件可能进入历史补位 |

`maxL1` / `maxL2` / `maxL3` 默认是 12 / 20 / 8，取值范围 0..200。设为 0 会关闭对应等级的独立段；它们不关闭「更早 · 按 S 补位」，后者最多取 4 条且不限等级。

**但是**——纯粹的"越新越重要"会漏掉低密度但关键的日期。所以加了两条补丁：

1. **时间桶配额**：今天 / 本周 / 更早 各保留 4 个，桶内按 S 排
2. **历史补位**：7 天以上不限等级按加权 S 补位，聊天类降权到 0.25、技术密度高的加权

这样"三天前那个只有两条消息的调试记录"不会因为条数少被彻底埋掉。

**"遗忘"的真实含义**：L4/L5 不单列等级段，但它们可能进入历史补位；完整内容**永远保留**，`memory_search` 随时能搜到。

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
const index = renderForPrompt(graded, { maxL1: 12, maxL2: 20, maxL3: 8 });

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
## 校验的严格程度

`node tools/verify-ids.mjs` 默认只把**结构损坏**（标记不配对、AUTO 区重复）、**悬空引用**、**条数不符**算失败。
这三类都是确定的错，红了就是真有问题。

膨胀倍数、锚点重复率这类启发式判据只打印「疑似异常」，不影响退出码 —— 它们会被正常的对话量波动误伤，
混进退出码只会逼人加 `|| true`，校验就废了。

需要严格时：

```bash
npm run verify:strict        # 等价于 node tools/verify-ids.mjs --strict
```

此时上面那些疑似项也升级为失败。日常用默认，发布前跑一次 strict。

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

**一、目录优先级**

四个入口共用同一套解析：`DSH_MEMORY_DIR` → `MEMORY_GALAXY_DIR` → Windows 上存在的 `D:\memory` → `<DSH_HOME>/memory`。跨平台请显式设 `DSH_MEMORY_DIR`；相对路径会按各进程的 cwd 转绝对，生产环境写绝对路径。

**二、需要 DSH 0.2.x**

用了 `ctx.systemPrompt.context()` 这个官方 API。本机按 DSH 0.2.2-rc.1 验证过；包通过 `peerDependencies` 声明宿主提供的 `@deepseek-ai/schemastery`，不把宿主内部包重复打进插件。注册时**必须**设 `interpolate: false`，否则记忆内容里出现 `{{` 会被当成提示变量解析直接抛错。

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