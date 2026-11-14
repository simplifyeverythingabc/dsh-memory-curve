#!/usr/bin/env node
/**
 * 干净环境验证脚本 —— 按真宿主的校验规则模拟。
 *
 * 模拟「别人刚装完」的场景：一份全新的内存目录、一个空的 DSH_HOME，
 * 从零加载插件，检查工具注册、context 注入、以及每个工具能不能真的干活。
 *
 * 这里的「假宿主」不是随便写的空壳 —— 校验规则照抄 DSH 的真实实现：
 *
 *   systemPrompt.context(context)
 *     要求 context.order 是有限数字，否则抛 TypeError
 *     （dsh-system-prompt/lib/index.js: context() 第一行就检查）
 *
 *   tools.register(definition)
 *     要求 definition.output 是对象，且 output.render 是函数，否则抛 TypeError
 *     （dsh-tools/lib/index.js: register() 开头就是这三个 instanceof 判断）
 *
 *   ctx.effect(callback, label)
 *     callback 执行，返回 disposer 函数；disposer 被调用时清理
 *
 * 故意用真规则而不是宽松模拟 —— 如果插件漏了哪个字段，这里就该红。
 *
 * 用法：
 *   node tools/selftest.mjs
 *   MC_SELFTEST_ROOT=/path/to/writable node tools/selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeDir } from '../src/paths.js';

const base = process.env.MC_SELFTEST_ROOT || tmpdir();
const root = mkdtempSync(join(base, 'mc-selftest-'));
const memDir = join(root, 'memory');
const dshHome = join(root, 'dsh-home');
mkdirSync(memDir, { recursive: true });
mkdirSync(dshHome, { recursive: true });

const day1 = [
  '2026-01-15 10:00 ［用户］ <!-- m_20260115_a1b2c3 -->',
  '连接池超时怎么排查',
  '',
  '2026-01-15 10:01 ［助手］ <!-- m_20260115_d4e5f6 -->',
  '先看 maxWait 和数据库的 wait_timeout，两边对不上就会超时。',
  '',
  '2026-01-15 10:30 ［用户］ <!-- m_20260115_1a2b3c -->',
  '改成 30 秒了，好多了',
].join('\n');

const day2 = [
  '2026-01-16 09:00 ［用户］ <!-- m_20260116_4d5e6f -->',
  '网关 401 了',
  '',
  '2026-01-16 09:01 ［助手］ <!-- m_20260116_7a8b9c -->',
  '八成是 header 没透传，把 Authorization 加进白名单。',
].join('\n');

writeFileSync(join(memDir, '2026-01-15.md'), day1, 'utf8');
writeFileSync(join(memDir, '2026-01-16.md'), day2, 'utf8');

process.env.DSH_MEMORY_DIR = memDir;
process.env.DSH_HOME = dshHome;

const rows = [];
const ok = (name, note = '') => { rows.push([true, name, note]); console.log(`  ✓ ${name.padEnd(26)} ${note}`); };
const bad = (name, note = '') => { rows.push([false, name, note]); console.log(`  ✗ ${name.padEnd(26)} ${note}`); };

let failed = 0;
const fail = (name, note) => { bad(name, note); failed++; };

try {
  if (process.platform === 'win32') {
    const unc = normalizeDir('//server/share/memory');
    if (unc !== '//server/share/memory') {
      fail('UNC 前斜杠路径', `应为 //server/share/memory，实际 ${unc}`);
    } else {
      ok('UNC 前斜杠路径', unc);
    }
  }

  const mod = await import('../src/index.js');

  // ── 声明层
  if (!Array.isArray(mod.inject) || !mod.inject.includes('systemPrompt') || !mod.inject.includes('tools')) {
    fail('inject 声明', `要为 ["systemPrompt","tools"]，实际 ${JSON.stringify(mod.inject)}`);
  } else {
    ok('inject 声明', JSON.stringify(mod.inject));
  }
  if (typeof mod.apply !== 'function') fail('apply 导出', `实际是 ${typeof mod.apply}`);
  else ok('apply 导出', 'function');
  if (typeof mod.name !== 'string') fail('name 导出', `实际是 ${typeof mod.name}`);
  else ok('name 导出', mod.name);

  // Config 是必需的：cordis.patch.yml 里的 config 段按它校验和补默认值。
  // 设置面板已移除，所以不再要求 volatile 字段存在的理由（那本来是为了让面板渲染表单）——
  // volatile 现在唯一的职责是让 Loader 把该字段包成 live 引用，值仍然来自 patch。
  const cfg = mod.Config;
  if (cfg === undefined) {
    fail('Config 导出', 'undefined（宿主环境必须有）');
  } else if (cfg && cfg.type === 'object' && cfg.dict && typeof cfg.toJSON === 'function') {
    const required = [
      'disabled', 'memoryDir', 'maxL1', 'maxL2', 'maxL3', 'injectContext',
      'autoCollect', 'collectSubagents', 'collectExcludeCwds', 'collectExcludeSessions',
      'collectFlushMs', 'collectScanMs', 'collectSummaryMs',
    ];
    const missing = required.filter((k) => !cfg.dict[k]);
    if (missing.length) fail('Config 字段', '缺 ' + missing.join(', '));
    else ok('Config 字段', required.join(', '));

    // disabled 必须是 boolean、默认 false —— 否则 patch 里写 true 会被 schema 剥掉，
    // apply 的守卫又变回永不触发的死代码。
    const dis = cfg.dict.disabled;
    if (!dis || dis.type !== 'boolean') {
      fail('disabled 类型', `应为 boolean，实际 ${dis?.type}`);
    } else if (dis.meta?.default !== false) {
      fail('disabled 默认值', `应为 false，实际 ${JSON.stringify(dis.meta?.default)}`);
    } else {
      ok('disabled 类型', 'boolean, default=false');
    }

    const md = cfg.dict.memoryDir;
    if (!md || md.type !== 'string') fail('memoryDir 类型', `应为 string，实际 ${md?.type}`);
    else ok('memoryDir 类型', `string, default=${JSON.stringify(md.meta?.default)}`);

    const ac = cfg.dict.autoCollect;
    if (!ac || ac.type !== 'boolean') fail('autoCollect 类型', `应为 boolean，实际 ${ac?.type}`);
    else if (ac.meta?.default !== false) fail('autoCollect 默认值', `应为 false，实际 ${JSON.stringify(ac.meta?.default)}`);
    else ok('autoCollect 类型', 'boolean, default=false');

    const cs = cfg.dict.collectSubagents;
    if (!cs || cs.type !== 'boolean') fail('collectSubagents 类型', `应为 boolean，实际 ${cs?.type}`);
    else if (cs.meta?.default !== false) fail('collectSubagents 默认值', `应为 false，实际 ${JSON.stringify(cs.meta?.default)}`);
    else ok('collectSubagents 类型', 'boolean, default=false');

    for (const k of ['collectExcludeCwds', 'collectExcludeSessions']) {
      const f = cfg.dict[k];
      if (!f || f.type !== 'string') fail(`${k} 类型`, `应为 string，实际 ${f?.type}`);
      else ok(`${k} 类型`, `string, default=${JSON.stringify(f.meta?.default)}`);
    }
    for (const k of ['collectFlushMs', 'collectScanMs', 'collectSummaryMs']) {
      const f = cfg.dict[k];
      if (!f || f.type !== 'number') fail(`${k} 类型`, `应为 number，实际 ${f?.type}`);
      else ok(`${k} 类型`, `number, default=${f.meta?.default}`);
    }

    for (const k of ['maxL1', 'maxL2', 'maxL3']) {
      const f = cfg.dict[k];
      if (!f || f.type !== 'number') fail(`${k} 类型`, `应为 number，实际 ${f?.type}`);
    }
    const badNums = ['maxL1', 'maxL2', 'maxL3'].filter((k) => typeof cfg.dict[k]?.meta?.default !== 'number');
    if (badNums.length) {
      fail('分级上限默认值', '应为数字：' + badNums.join(', '));
    } else {
      // 文案里的数字从 schema 现读，不写死 —— 以前这里是 'maxL1=12 maxL2=20 maxL3=8'
      // 的常量字符串，src 里的默认值改了它照样报绿，是条假绿灯文案。
      const got = ['maxL1', 'maxL2', 'maxL3'].map((k) => `${k}=${cfg.dict[k].meta.default}`).join(' ');
      ok('分级上限默认值', got);
    }
  } else {
    fail('Config 导出', `形状不对：${typeof cfg}`);
  }

  // ── injectContext:false 的行为断言 ────────────────────────────────
  //
  // 只查「context 没注册」不够。曾经有过的 bug：兼容通道 prompt.variable 漏了守卫，
  // 在「只有 variable 没有 context」的 profile 上 injectContext=false 照样注册变量，
  // 日志却打印「索引不注入」—— 配置说了假话。这里两条通道一起断。
  if (typeof mod.apply === 'function') {
    const seen = [];
    const probe = {
      systemPrompt: {
        context(def) { seen.push('context'); return () => {}; },
        variable(nm) { seen.push(`variable:${nm}`); return () => {}; },
      },
      tools: { register() { return () => {}; } },
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
      on() { return () => {}; },
    };
    try {
      mod.apply(probe, { injectContext: false });
      if (seen.length) fail('injectContext:false 拦截', `仍注册了 ${seen.join(', ')}`);
      else ok('injectContext:false 拦截', 'context 与 variable 都不注册');
    } catch (e) {
      fail('injectContext:false 拦截', `apply 抛错：${e?.message ?? e}`);
    }

    // 上面那组探针同时给了 context 和 variable —— 兼容通道第一句
    // `typeof prompt?.context === 'function'` 就返回了，永远走不到 injectContext 守卫。
    // 所以它只证明主通道有效。要防「兼容通道守门被删」这个回归，必须再来一组
    // 只给 variable 的探针；实测删掉守卫时只有这一组会红。
    const seenVar = [];
    const probeVarOnly = {
      systemPrompt: { variable(nm) { seenVar.push(`variable:${nm}`); return () => {}; } },
      tools: { register() { return () => {}; } },
      effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
      on() { return () => {}; },
    };
    try {
      mod.apply(probeVarOnly, { injectContext: false });
      if (seenVar.length) fail('injectContext:false 拦截（仅 variable）', `仍注册了 ${seenVar.join(', ')}`);
      else ok('injectContext:false 拦截（仅 variable）', 'variable 通道也不注册');
    } catch (e) {
      fail('injectContext:false 拦截（仅 variable）', `apply 抛错：${e?.message ?? e}`);
    }
  }

  // ── 假宿主：照真宿主的校验规则
  const tools = {};
  const contexts = [];
  const effects = [];
  const disposers = [];
  const pendingAsync = [];

  let contextSeq = 0;
  const ctx = {
    // 真签名：effect(execute, label = 'anonymous')
    // execute 无参数调用，返回值可以是四种之一：
    //   单个 disposer / 迭代器（每个 yield 一个 disposer）/ Promise<disposer> / 异步迭代器
    // 真实现全部收集到 disposables，卸载时反序执行，且只执行一次（disposing 标志）
    effect(execute, label = 'anonymous') {
      if (typeof execute !== 'function') {
        throw new TypeError('effect execute must be a function');
      }
      effects.push(label);
      const collected = [];
      const collect = (d) => { if (typeof d === 'function') collected.push(d); };

      const raw = execute();
      if (raw && typeof raw[Symbol.iterator] === 'function' && typeof raw !== 'function') {
        for (const d of raw) collect(d);
      } else if (raw && typeof raw.then === 'function') {
        pendingAsync.push(Promise.resolve(raw).then(collect));
      } else {
        collect(raw);
      }

      let disposing = false;
      const dispose = () => {
        if (disposing) return;
        disposing = true;
        for (const d of collected.splice(0).reverse()) d();
      };
      disposers.push(dispose);
      return dispose;
    },
    systemPrompt: {
      // 真校验：order 必须是有限数字
      context(definition) {
        if (!definition || typeof definition !== 'object') {
          throw new TypeError('prompt context must be an object');
        }
        if (!Number.isFinite(definition.order)) {
          throw new TypeError(`prompt context "${definition.name}" order must be a finite number`);
        }
        if (typeof definition.name !== 'string' || !definition.name) {
          throw new TypeError('prompt context name must be a non-empty string');
        }
        if (typeof definition.text !== 'function' && typeof definition.text !== 'string') {
          throw new TypeError(`prompt context "${definition.name}" text must be a string or function`);
        }
        contexts.push({ ...definition, seq: contextSeq++ });
        return () => {};
      },
      variable(name, value) {
        if (typeof name !== 'string' || !name) throw new TypeError('variable name must be a non-empty string');
        contexts.push({ kind: 'variable', name, value, seq: contextSeq++ });
        return () => {};
      },
    },
    tools: {
      // 真校验：output 必须是对象且 render 必须是函数
      register(definition, options = {}) {
        const name = definition && definition.name;
        const output = definition && definition.output;
        if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
          throw new TypeError(`tool "${name}" must declare output.render as a function`);
        }
        if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
          throw new TypeError(`tool "${name}" output.presentationMeta must be a function when present`);
        }
        if (typeof name !== 'string' || !name) {
          throw new TypeError('tool name must be a non-empty string');
        }
        if (tools[name]) {
          throw new TypeError(`tool "${name}" already registered`);
        }
        if (definition.parameters && definition.parameters.type !== 'object') {
          throw new TypeError(`tool "${name}" parameters must be an object schema`);
        }
        tools[name] = definition;
        return () => { delete tools[name]; };
      },
      restrict() { return () => {}; },
    },
    get(key) { return undefined; },
  };

  // ── apply
  try {
    mod.apply(ctx, { maxL1: 12, maxL2: 20, maxL3: 8, memoryDir: '' });
    ok('apply() 执行', `注册 ${Object.keys(tools).length} 个工具，${contexts.length} 个 context`);
  } catch (e) {
    fail('apply() 执行', e.message.slice(0, 80));
  }

  // ── 工具齐全
  const expected = [
    'memory_search', 'memory_curve_day', 'memory_curve_raw',
    'memory_curve_days', 'memory_curve_show', 'memory_curve_build',
  ];
  const missing = expected.filter(n => !tools[n]);
  if (missing.length) fail('六个工具齐全', '缺 ' + missing.join(', '));
  else ok('六个工具齐全');

  // ── context 注入
  const ctxDef = contexts.find(c => c.kind !== 'variable' && c.name === 'memory-curve-index');
  if (!ctxDef) {
    fail('context 注册', '没找到 name=memory-curve-index 的 context');
  } else {
    ok('context 注册', `order=${ctxDef.order} interpolate=${ctxDef.interpolate}`);
    if (ctxDef.interpolate !== false) {
      fail('interpolate 设置', `必须是 false，实际 ${ctxDef.interpolate}（记忆正文里出现 {{ 会抛错）`);
    } else {
      ok('interpolate 设置', 'false —— 正文含 {{ 也不会被解析');
    }
    if (typeof ctxDef.text !== 'function') {
      fail('context.text', `应该是函数（每步重算），实际 ${typeof ctxDef.text}`);
    } else {
      const out = String(ctxDef.text());
      ok('context 求值', `${out.length} 字符`);
      if (!out.includes('记忆事件索引')) fail('context 内容', '缺少标题行');
    }
  }

  // ── 分级上限真的生效
  // 之前 layered() 只把 total 当「补名额」的上限，不当「削」的上限，
  // 而默认 12 恰好等于 4+4+4，所以 maxL1 配小了完全没效果。
  try {
    const { renderForPrompt } = await import('../src/events.js');
    const FIXED = Date.now();   // 传进去固定住，避免跨午夜翻桶
    const base = FIXED - 3600000;
    const mk = (idx, level, offset) => ({
      idx, level, startAt: base + offset, count: 2, S: 8, head: '事件' + idx,
    });
    const fake = [
      mk(0, 'L1', 0), mk(1, 'L1', 60),
      mk(2, 'L2', 120), mk(3, 'L2', 180),
      mk(4, 'L3', 240), mk(5, 'L3', 300),
    ];

    const zero = renderForPrompt(fake, { maxL1: 0, maxL2: 0, maxL3: 0, now: FIXED });
    const leaks = ['L1 核心事件', 'L2 长期事件', 'L3 活跃事件'].filter((s) => zero.includes(s));
    if (leaks.length) {
      fail('分级上限生效', `maxLx=0 仍注入了：${leaks.join(' / ')}`);
    } else {
      const two = renderForPrompt(fake, { maxL1: 2, maxL2: 2, maxL3: 2, now: FIXED });
      const n = (two.match(/^- /gm) || []).length;
      if (n !== 6) fail('分级上限生效', `三个 2 应得 6 条，实得 ${n}`);
      else ok('分级上限生效', 'maxLx=0 三段全消失，都设 2 得 6 条');
    }
  } catch (e) {
    fail('分级上限生效', e.message.slice(0, 80));
  }

  // ── 0.4.0 记忆动力学：遗忘曲线 / 再巩固 / 间隔效应 / 显著性 / 相对配额
  //
  // 这几条是「模型层」的断言，不依赖宿主。每条都在验一个具体的心理学机制，
  // 而不是「代码跑起来了」——否则公式写反了也能绿灯。
  const DAY = 86400000;
  const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);   // 固定基准，避免跨午夜翻车的假红

  try {
    const ev = await import('../src/events.js');

    // (1) 幂律曲线在 x=1 处与指数曲线对齐 —— S 的「天数」语义跨版本可比
    const r1 = Math.pow(1 + ev.POWER_K, -ev.POWER_BETA);
    const e1 = Math.exp(-1);
    if (Math.abs(r1 - e1) > 0.01) {
      fail('幂律/指数对齐点', `x=1 期望 ${e1.toFixed(3)}，实得 ${r1.toFixed(3)}`);
    } else {
      ok('幂律/指数对齐点', `x=1 两边都是 ${r1.toFixed(3)}`);
    }

    // (2) 长尾必须更厚 —— 这是换幂律的唯一理由
    const r10 = Math.pow(1 + ev.POWER_K * 10, -ev.POWER_BETA);
    if (r10 <= 0.1) {
      fail('长尾更厚', `x=10 得 ${r10.toFixed(4)}，不够平（应 >0.1）`);
    } else {
      ok('长尾更厚', `x=10 幂律 ${r10.toFixed(3)} vs 指数 ${Math.exp(-10).toExponential(1)}`);
    }

    // (3) 间隔效应：分散提取 > 集中重复
    const iso = (ms) => new Date(ms).toISOString();
    const spaced = ev.spacingOf([-5, -4, -3, -2, -1].map((d) => iso(NOW + d * DAY)), NOW);
    const massed = ev.spacingOf([0, 0, 0, 0, 0].map(() => iso(NOW - 60000)), NOW);
    if (!(spaced > 1.1)) {
      fail('间隔效应', `分散提取只得到 ${spaced}，应 >1.1`);
    } else if (massed !== 1) {
      fail('间隔效应', `集中重复不该加分，实得 ${massed}`);
    } else {
      ok('间隔效应', `分散 ${spaced} / 集中 ${massed}`);
    }

    // (4) 同一分钟的多次提取合并成一次 —— 否则「一次查 30 条」会被算成极度密集
    const accFile = join(root, 'access-selftest.json');
    const t1 = iso(NOW - 2 * DAY);
    const t2 = iso(NOW - 1 * DAY);
    writeFileSync(accFile, JSON.stringify({
      same: { n: 3, last: t1, first: t1, ts: [t1, t1, t1] },
      spread: { n: 2, last: t2, first: t1, ts: [t1, t2] },
    }), 'utf8');
    const acc = await import('../src/access.js');
    const A = acc.sumAccess(accFile, ['same']);
    const B = acc.sumAccess(accFile, ['spread']);
    if (A.ts.length !== 1) {
      fail('同分钟提取合并', `3 个同分钟时间戳应合成 1 次，实得 ${A.ts.length}`);
    } else if (B.ts.length !== 2) {
      fail('同分钟提取合并', `跨天两次应保留 2 次，实得 ${B.ts.length}`);
    } else {
      ok('同分钟提取合并', `同分钟 ${A.ts.length} 次 / 跨天 ${B.ts.length} 次`);
    }

    // (5) 再巩固：最近被提取过的记忆，衰减起点更晚 -> R 更高
    const mkEv = (id, at, texts, spanMs = 0) => ({
      day: iso(at).slice(0, 10), startAt: at, lastAt: at + spanMs,
      items: texts.map(() => ({})), texts,
      toks: new Set(texts.join(' ').split(/\s+/).filter((s) => s.length >= 2)),
      ids: [id], salience: 1,
    });
    const old = NOW - 12 * DAY;
    const fresh = mkEv('reb1', old, ['排查连接池超时'], 3600000);
    const gNone = ev.gradeEvents([mkEv('reb1', old, ['排查连接池超时'], 3600000)], NOW,
      () => ({ n: 0, last: null, ts: [] }));
    const gHit = ev.gradeEvents([mkEv('reb1', old, ['排查连接池超时'], 3600000)], NOW,
      () => ({ n: 3, last: iso(NOW - 60000), ts: [] }));
    if (!(gHit[0].R > gNone[0].R + 0.1)) {
      fail('提取再巩固', `被查过 R=${gHit[0].R}，没查过 R=${gNone[0].R}，差距不够`);
    } else if (gHit[0].ageH >= gNone[0].ageH) {
      fail('提取再巩固', `衰减起点没重算：ageH ${gHit[0].ageH} vs ${gNone[0].ageH}`);
    } else {
      ok('提取再巩固', `R ${gNone[0].R} -> ${gHit[0].R}，ageH ${gNone[0].ageH} -> ${gHit[0].ageH}`);
    }

    // (6) 显著性只奖给「最有事发生的那批」，且封顶 1.35
    const calmA = { texts: ['今天天气不错，看了会儿书'], items: [{}] };
    const calmB = { texts: ['整理了一下文件目录'], items: [{}] };
    const calmC = { texts: ['把配置读了一遍'], items: [{}] };
    const rough = { texts: ['不对，这里必须重来', '又报错了，失败了三次', '这次修好了'], items: [{}, {}, {}] };
    ev.salienceAll([calmA, calmB, calmC, rough]);
    if (!(rough.salience > calmA.salience)) {
      fail('情绪显著性', `有事发生的 ${rough.salience} 不高于平淡的 ${calmA.salience}`);
    } else if (rough.salience > 1.35) {
      fail('情绪显著性', `封顶失效：${rough.salience} > 1.35`);
    } else if (calmA.salience !== 1) {
      fail('情绪显著性', `中位数以下应保持 1，实得 ${calmA.salience}`);
    } else {
      ok('情绪显著性', `平淡 ${calmA.salience} / 有冲突 ${rough.salience}`);
    }

    // (7) 相对配额：一堆同样够格的事件，L1 不能超过总量的 10%
    //     这一条直接守住「注入量不随对话变长而膨胀」——以前 L1 数量随历史线性涨。
    //     构造上让 lastAt 紧贴基准时刻（R 接近 1），起止跨 12 天（S 够 6），
    //     确保它们**全都**过得了绝对闸，这样测的才是配额而不是阈值。
    const big = Array.from({ length: 50 }, (_, i) => {
      const lastAt = NOW - i * 60000;
      return {
        day: iso(lastAt).slice(0, 10),
        startAt: lastAt - 12 * DAY,
        lastAt,
        items: new Array(30).fill({}),
        texts: ['批量事件' + i],
        toks: new Set(['aa' + i, 'bbbb', 'cccc']),
        ids: ['big' + i],
        salience: 1,
      };
    });
    const gBig = ev.gradeEvents(big, NOW);
    const l1n = gBig.filter((x) => x.level === 'L1').length;
    const eligible = gBig.filter((x) => x.R >= 0.568 && x.S >= 6).length;
    const cap = Math.max(3, Math.round(50 * 0.10));
    const dm = gBig.filter((x) => x.demoted).length;
    if (eligible < 40) {
      fail('相对配额', `夹具没构造好：只有 ${eligible} 个过绝对闸`);
    } else if (l1n > cap) {
      fail('相对配额', `L1 有 ${l1n} 个，超过配额 ${cap}`);
    } else if (l1n === 0) {
      fail('相对配额', '一个 L1 都没有，绝对闸没放进来');
    } else if (dm === 0) {
      fail('相对配额', '没有事件被降级，配额没生效');
    } else {
      ok('相对配额', `${eligible} 个够格 -> L1 ${l1n}（上限 ${cap}），降级 ${dm}`);
    }
  } catch (e) {
    fail('记忆动力学', e.message.slice(0, 90));
  }

  // ── 工具有没有真的干活
  const toText = (name, raw) => {
    const tool = tools[name];
    if (tool && tool.output && typeof tool.output.render === 'function') {
      try {
        const parts = tool.output.render({}, raw);
        if (Array.isArray(parts)) {
          const joined = parts.map(p => (p && p.text) || '').filter(Boolean).join('\n');
          if (joined) return joined;
        }
      } catch { /* 退回兜底 */ }
    }
    if (raw && typeof raw === 'object' && typeof raw.text === 'string') return raw.text;
    return JSON.stringify(raw);
  };

  const run = async (name, fn) => {
    if (!tools[name]) return '';
    try {
      const raw = await fn();
      const text = toText(name, raw);
      ok(name, String(text).split('\n')[0].slice(0, 58));
      return text;
    } catch (e) {
      fail(name, e.message.slice(0, 70));
      return '';
    }
  };

  await run('memory_curve_days', () => tools.memory_curve_days.execute());
  await run('memory_curve_build', () => tools.memory_curve_build.execute());
  const searchText = await run('memory_search', () => tools.memory_search.execute({ pattern: '连接池', maxHits: 3 }));
  await run('memory_curve_day', () => tools.memory_curve_day.execute({ day: '2026-01-15' }));
  await run('memory_curve_show', () => tools.memory_curve_show.execute({ level: 'L1', maxChars: 300 }));

  const m = searchText.match(/m_\d{8}_[0-9a-f]{6}/);
  if (m) {
    await run('memory_curve_raw', () => tools.memory_curve_raw.execute({ id: m[0], maxChars: 100 }));
  } else {
    fail('memory_curve_raw', '搜索结果里没有 id');
  }

  // ── 清理：所有 disposer 都应能安全调用（不能抛）
  try {
    for (const d of disposers) d();
    ok('disposer 可调用', `${disposers.length} 个全部无异常`);
  } catch (e) {
    fail('disposer 可调用', e.message.slice(0, 70));
  }

  // ── 报告
  console.log('');
  console.log(`  检查项 ${rows.length}　通过 ${rows.length - failed}　失败 ${failed}`);
} catch (e) {
  const msg = String((e && e.message) || e);
  if (e && e.code === 'ERR_MODULE_NOT_FOUND' && msg.includes('@deepseek-ai/schemastery')) {
    console.log('  ✗ 致命错误: 缺少 @deepseek-ai/schemastery');
    console.log('    仓库目录请先按 .github/workflows/ci.yml 的「造 schemastery stub」那段造 stub，');
    console.log('    或到部署目录（宿主已提供该包）里跑。');
  } else if (/is not a function/.test(msg)) {
    const m = msg.match(/z\.([A-Za-z_$][\w$]*) is not a function/);
    console.log(`  ✗ 致命错误: schemastery stub 缺 z.${m ? m[1] : '<方法>'}()`);
    console.log('    stub 需要提供 string / number / boolean / object，');
    console.log('    以及 default / description / volatile / min / max 链式方法。');
  } else {
    console.log(`  ✗ 致命错误: ${msg}`);
  }
  if (process.env.MC_SELFTEST_DEBUG) console.error(e);
  failed++;
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

console.log('');
console.log(failed ? `✗ ${failed} 项失败` : '✓ 全部通过 —— 干净环境可跑');
process.exit(failed ? 1 : 0);