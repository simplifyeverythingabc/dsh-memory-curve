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
    mod.apply(ctx, { maxT1: 12, maxT2: 20, maxT3: 8 });
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
  await run('memory_curve_show', () => tools.memory_curve_show.execute({ level: 'T1', maxChars: 300 }));

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
  console.log(`  ✗ 致命错误: ${e.message}`);
  if (process.env.MC_SELFTEST_DEBUG) console.error(e);
  failed++;
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

console.log('');
console.log(failed ? `✗ ${failed} 项失败` : '✓ 全部通过 —— 干净环境可跑');
process.exit(failed ? 1 : 0);