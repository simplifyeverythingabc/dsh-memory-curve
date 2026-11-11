# 贡献指南

## 跑起来

```bash
git clone https://github.com/simplifyeverythingabc/dsh-memory-curve.git
cd dsh-memory-curve

# 语法检查
npm run check

# 造一份最小流水试试
mkdir -p /tmp/memory
cat > /tmp/memory/2026-01-15.md <<'EOF'
2026-01-15 10:00 ［用户］ <!-- m_20260115_a1b2c3 -->
连接池超时怎么排查

2026-01-15 10:01 ［助手］ <!-- m_20260115_d4e5f6 -->
先看 maxWait 和数据库的 wait_timeout，两边对不上就会超时。
EOF

DSH_MEMORY_DIR=/tmp/memory node --input-type=module -e "
  import { readEntries, clusterEvents, gradeEvents } from './src/events.js';
  const e = readEntries('/tmp/memory');
  const ev = clusterEvents(e);
  console.log(gradeEvents(ev, Date.now(), () => ({n:0,last:null})).map(x => x.level));
"
```

## 代码结构

```
src/events.js   聚类 + 分级 + 渲染
src/digest.js   搜索 + 取文
src/index.js    插件入口，注册 6 个工具和 context
src/access.js   访问计数
```

**四个文件有严格的职责边界**：

- `events.js` 只管「怎么把条目切成事件、怎么算 S 和 R」
- `digest.js` 只管「怎么从流水里找到东西」
- `index.js` 只管「怎么把结果塞进上下文、怎么暴露工具」
- `access.js` 只管「谁被查过几次」

**改分级算法只动 `events.js`，改搜索只动 `digest.js`。** 不要因为改一处而把逻辑摊到别的文件里。

## 提交什么

改代码的 PR 请带上：

1. **为什么改** —— 什么现象让你觉得现在的行为不对
2. **怎么验证的** —— 用什么数据跑出来的结果，最好是能复现的最小例子
3. **有没有副作用** —— 比如改了打分权重，会不会影响别的查询

**如果你改了排序或打分**，请同时贴出改动前后的对比：

```
改之前：query "缓存 失效 排查" → 期望条排第 8
改之后：query "缓存 失效 排查" → 期望条排第 2
```

没有前后对比的排序改动没法评估。

## 数据格式不能随便改

流水文件的格式是**对外契约**，别人已经在用：

```
YYYY-MM-DD HH:MM ［说话人］ <!-- m_YYYYMMDD_<6位十六进制> -->
正文
```

改这个格式等于让所有人的历史数据作废。真要改，得同时提供迁移脚本，并且在 CHANGELOG 里标 **BREAKING**。

**锚点必须是内容哈希**，不能改回递增序号。原因见 CHANGELOG 里「踩过的坑」那张表——序号会在每次重建时漂移，导致访问计数和所有引用指向错内容。

## 别做的事

- **不要引入新的运行时依赖**。现在整个插件是零依赖的，这是有意的
- **不要在 `events.js` 里加 I/O**。它应该是纯函数，好测
- **不要用「前 N 个字」当去重判据**。踩过两次了，见 CHANGELOG
- **不要把记忆内容写进日志**。用户的历史对话是私密的

## 报告问题

开 issue 时带上：

```
插件版本（能看到的话）：
DSH 版本：
Node 版本：
现象：
复现步骤：
```

**如果是搜索质量的问题**，请附上：你的 query、期望找到什么、实际找到了什么（排名第几）。这三样齐了才能判断是召回问题还是排序问题——这俩的修法完全不同。

## License

提交即同意以 MIT 协议发布。