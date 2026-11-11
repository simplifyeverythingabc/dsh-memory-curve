#!/usr/bin/env node
/**
 * 检索质量基准 —— 自带夹具，不读任何真实数据。
 *
 * 为什么单独做一份：真实数据每天都在长，硬编码它的查询词和期望值等于把
 * 个人历史写进公开仓库；而完全不测检索质量，别人改了打分逻辑也没东西能
 * 告诉他「变好了还是变坏了」。
 *
 * 折中办法就是这份：造四天假对话（一个 Java 服务的排查过程），查询词和
 * 期望锚点全部绑在这份夹具上。夹具一改，期望值跟着改，永远自洽。
 *
 * 七类查询，对应七种检索难点：
 *
 *   term   精确术语      —— 单词命中，不许被分词拆散
 *   cn     中文短语      —— 二元切词的死角
 *   multi  多词组合      —— coverage 加权有没有把正确答案压下去
 *   cross  跨天主题      —— 同一件事分散在多天，能捞回来
 *   evo    演化修正      —— 同一话题改过几次，必须命中最后那版
 *   hist   历史召回      —— 正确答案只命中一个词的情况（已知偏斜点）
 *   neg    负例          —— 不存在的词，不许乱命中
 *
 * 每个用例的判定按优先级：
 *   1. expectZero  → 必须零命中
 *   2. anchor      → 返回片段的任一含这句话就算过（跟内容走，不怕 id 漂移）
 *   3. want        → 命中指定 id 之一
 *   4. wantDay     → 至少命中指定日期
 *   5. 都没有      → 只要不崩就算过
 *
 * 用法：
 *   node tools/bench.mjs
 *   MC_BENCH_ROOT=/path/to/writable node tools/bench.mjs   # 临时目录不可写时
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { searchAll, listDays, makeMatcher } from '../src/digest.js';
import { createHash } from 'node:crypto';

// ── 夹具：四天，一个 JDBC 连接池排查过程
const DAYS = {
  '2026-02-10': [
    ['09:12', '用户', '连接池老是超时，报 CannotGetJdbcConnectionException'],
    ['09:13', '助手', '超时这事先确认 wait_timeout。MySQL 默认 8 小时，连接池如果配的比它长，回收时一定会撞上已断开的连接。排查顺序是先看这个。'],
    ['09:30', '用户', 'maxWait 现在是 30000'],
    ['09:31', '助手', 'maxWait 是从池里借连接的等待上限，跟 wait_timeout 不是一回事。真正要改的是 maxLifetime，把它压到比 wait_timeout 小几分钟。'],
    ['14:20', '用户', 'maxLifetime 改成 28 分钟了，观察一天'],
    ['14:21', '助手', '顺便把 validationQuery 配上，借出前验一下，能挡住已经死掉的连接。'],
  ],
  '2026-02-11': [
    ['10:05', '用户', '超时少多了，但还有零星的'],
    ['10:06', '助手', '剩下的可能是慢查询占着连接不放。开 leakDetectionThreshold，设成 20 秒，看谁借了不还。'],
    ['10:40', '用户', 'leak 打开后抓到一条，是那个导出报表的接口'],
    ['10:41', '助手', '报表那个接口慢，是因为导出没走分页，一次捞全表。改成游标分批读，每次 500 行。'],
  ],
  '2026-02-12': [
    ['11:00', '用户', '网关那边 401 了，本地跑是好的'],
    ['11:01', '助手', '本地好线上坏，八成是 header 没透传。让网关把 Authorization 加进转发白名单，别在协议转换时丢掉。'],
    ['11:20', '用户', '加了，通了'],
    ['11:21', '助手', '顺手把 X-Request-Id 也透传过去，排查时全靠它串日志。'],
    ['16:30', '用户', 'nacos 的配置想挪到本地文件'],
    ['16:31', '助手', '先确认有没有动态刷新需求。纯静态的话换成 spring.config.import 引本地 yml，启动更快也不依赖注册中心。'],
  ],
  '2026-02-13': [
    ['09:15', '用户', '本地文件方案定了，但想保留热更新'],
    ['09:16', '助手', '配置方案最终定的是 spring.config.import 加 optional:nacos:，本地兜底、远端优先，两边都能读到。'],
    ['09:50', '用户', '内存溢出了，导出那个接口'],
    ['09:51', '助手', '游标分批读的时候类型没设成流式。MySQL 驱动要 statementType 用 FORWARD_ONLY 加 fetchSize 设成 Integer.MIN_VALUE 才会真流式。'],
    ['15:00', '用户', '改完内存稳了，导 50 万行也就两百兆'],
    ['15:01', '助手', '这才是正常水平。之前一次捞全表，光 ResultSet 就得几个 G。'],
  ],
};

const dir = (() => {
  const base = process.env.MC_BENCH_ROOT || tmpdir();
  const d = mkdtempSync(join(base, 'mc-bench-'));
  mkdirSync(d, { recursive: true });
  return d;
})();

function anchorOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 6);
}

// 写流水（带内容哈希锚点，和真实格式一致）
for (const [day, items] of Object.entries(DAYS)) {
  const lines = [];
  for (const [hhmm, who, text] of items) {
    const id = `m_${day.replace(/-/g, '')}_${anchorOf(text)}`;
    lines.push(`${day} ${hhmm} ［${who}］ <!-- ${id} -->`);
    lines.push(text);
    lines.push('');
  }
  writeFileSync(join(dir, `${day}.md`), lines.join('\n'), 'utf8');
}

// ── 用例
const CASES = [
  // term：精确术语
  { q: 'CannotGetJdbcConnectionException', type: 'term', wantDay: '2026-02-10' },
  { q: 'validationQuery',                  type: 'term', wantDay: '2026-02-10' },
  { q: 'leakDetectionThreshold',           type: 'term', wantDay: '2026-02-11' },
  { q: 'spring.config.import',             type: 'term', wantDay: '2026-02-12' },
  { q: 'Integer.MIN_VALUE',                type: 'term', wantDay: '2026-02-13' },
  { q: 'FORWARD_ONLY',                     type: 'term', wantDay: '2026-02-13' },
  { q: 'X-Request-Id',                     type: 'term', wantDay: '2026-02-12' },
  { q: 'wait_timeout',                     type: 'term', wantDay: '2026-02-10' },

  // cn：中文短语
  { q: '连接池',        type: 'cn', wantDay: '2026-02-10' },
  { q: '慢查询',        type: 'cn', wantDay: '2026-02-11' },
  { q: '游标分批读',     type: 'cn', wantDay: '2026-02-13' },
  { q: '热更新',        type: 'cn', wantDay: '2026-02-13' },
  { q: '内存溢出',       type: 'cn', wantDay: '2026-02-13' },
  { q: '白名单',        type: 'cn', wantDay: '2026-02-12' },

  // multi：多词组合
  { q: 'maxLifetime wait_timeout',  type: 'multi', wantDay: '2026-02-10' },
  { q: '游标 fetchSize 流式',        type: 'multi', wantDay: '2026-02-13' },
  { q: '网关 Authorization 透传',    type: 'multi', wantDay: '2026-02-12' },
  { q: 'nacos 本地 yml',            type: 'multi', wantDay: '2026-02-12' },
  { q: '导出 报表 连接',             type: 'multi', wantDay: '2026-02-11' },

  // cross：跨天主题（同一个话题分散在多天）
  { q: '连接池 超时',   type: 'cross', wantDay: ['2026-02-10', '2026-02-11'] },
  { q: '导出',         type: 'cross', wantDay: ['2026-02-11', '2026-02-13'] },
  { q: '配置',         type: 'cross', wantDay: ['2026-02-12', '2026-02-13'] },

  // evo：演化修正，锚点指向最终版本
  { q: '配置 方案 最终', anchor: '配置方案最终定的是', type: 'evo' },
  { q: 'maxLifetime 改成', anchor: 'maxLifetime 改成 28 分钟', type: 'evo' },
  { q: '内存 改完', anchor: '改完内存稳了', type: 'evo' },

  // hist：正确答案只命中一个词（已知的 coverage 偏斜点）
  { q: '超时 怎么 排查',   anchor: '超时这事先确认 wait_timeout', type: 'hist' },
  { q: '401 本地 好的',    anchor: 'header 没透传', type: 'hist' },
  { q: '内存 五十万 行',   anchor: '导 50 万行也就两百兆', type: 'hist' },
  { q: '报表 接口 慢',     anchor: '报表那个接口慢', type: 'hist' },
  { q: '连接 借出 验证',   anchor: 'validationQuery 配上', type: 'hist' },

  // neg：不该命中
  { q: 'zzz_never_exists_42', type: 'neg', expectZero: true },
  { q: 'QQQ999XYZ',           type: 'neg', expectZero: true },
  { q: '0xffffffff',          type: 'neg', expectZero: true },
];

// ── 跑
const memDir = dir;
const days = listDays({ memDir, digestDir: null });

let pass = 0, fail = 0, zero = 0;
const byType = {};
const rows = [];

for (const c of CASES) {
  const r = searchAll({ memDir, pattern: c.q, maxHits: 10 });
  const hitDays = new Set(r.hits.map((h) => h.day));
  const hitIds = new Set(r.hits.map((h) => h.id));

  let ok, why;
  if (c.expectZero) {
    ok = r.total === 0;
    why = ok ? '正确无命中' : `误命中 ${r.total} 条`;
  } else if (c.anchor) {
    ok = r.hits.some((h) => h.snippet.includes(c.anchor));
    why = ok ? '命中锚点' : `未命中锚点「${c.anchor.slice(0, 18)}」`;
  } else if (c.want && c.want.length) {
    ok = c.want.some((id) => hitIds.has(id));
    why = ok ? '命中 id' : `未命中（实得 ${[...hitIds].slice(0, 3).join(',') || '无'}）`;
  } else if (c.wantDay) {
    const ds = Array.isArray(c.wantDay) ? c.wantDay : [c.wantDay];
    ok = ds.some((d) => hitDays.has(d));
    why = ok ? `命中 ${ds.find((d) => hitDays.has(d))}` : `未命中 ${ds.join('/')}（实得 ${[...hitDays].slice(0, 3).join(',') || '无'}）`;
  } else {
    ok = true;
    why = r.total ? `命中 ${r.total}` : '无命中（可接受）';
  }

  if (ok) pass++; else fail++;
  if (r.total === 0 && !c.expectZero) zero++;
  byType[c.type] = byType[c.type] || { pass: 0, fail: 0 };
  byType[c.type][ok ? 'pass' : 'fail']++;
  rows.push({ ...c, total: r.total, shown: r.hits.length, mode: r.mode, ok, why });
}

const w = (s, n) => String(s).padEnd(n);
console.log(`检索基准：${CASES.length} 条　夹具 ${days.length} 天　通过 ${pass}　失败 ${fail}　零命中 ${zero}\n`);
for (const [t, v] of Object.entries(byType)) {
  console.log(`  ${w(t, 8)} ${v.pass}/${v.pass + v.fail}`);
}
console.log('');
console.log(w('query', 34), w('命中', 5), w('模式', 14), w('结果', 5), '说明');
for (const r of rows) {
  console.log(
    w(r.q, 34), w(r.total, 5), w(r.mode || '—', 14),
    w(r.ok ? '✓' : '✗', 5), r.why,
  );
}

// 精确率
let prec = 0, precN = 0;
for (const c of CASES) {
  if (c.expectZero) continue;
  const r = searchAll({ memDir, pattern: c.q, maxHits: 10 });
  const { re } = makeMatcher(c.q.split(/\s+/)[0]);
  for (const h of r.hits) { precN++; if (re.test(h.snippet)) prec++; }
}
console.log(`\n精确率（首词出现在片段里）：${prec}/${precN} = ${(prec / Math.max(precN, 1) * 100).toFixed(1)}%`);

try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
process.exitCode = fail ? 1 : 0;