#!/usr/bin/env node
/**
 * 干净环境验证脚本。
 *
 * 模拟「别人刚装完」的场景：一份全新的内存目录、一个空的 DSH_HOME，
 * 从零加载插件，检查工具注册、context 注入、以及每个工具能不能真的干活。
 *
 * 用法：
 *   node tools/selftest.mjs
 *
 * 默认在系统临时目录里造一份最小流水，跑完自动清理。
 * 如果临时目录不可写（某些受限环境），用 MC_SELFTEST_ROOT 指定一个可写目录：
 *   MC_SELFTEST_ROOT=/path/to/writable node tools/selftest.mjs
 *
 * 不需要 DSH 在跑，不需要真实历史数据。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
const say = (ok, name, note = '') => {
  rows.push([ok, name, note]);
  console.log(`  ${ok} ${name.padEnd(24)} ${note}`);
};

let failed = 0;

try {
  const mod = await import('../src/index.js');

  say('✓', '模块加载', `inject=${JSON.stringify(mod.inject)}`);
  if (!Array.isArray(mod.inject) || !mod.inject.includes('systemPrompt')) {
    say('✗', 'inject 声明', '缺少 systemPrompt');
    failed++;
  }

  const tools = {};
  let contextText = null;
  const disposers = [];

  const ctx = {
    effect(fn) { return fn(); },
    systemPrompt: {
      context(def) {
        contextText = def.text;
        return () => {};
      },
    },
    tools: {
      register(def) {
        tools[def.name] = def;
        return () => {};
      },
    },
  };

  mod.apply(ctx, { maxT1: 12, maxT2: 20, maxT3: 8 });
  say('✓', 'apply()', `注册 ${Object.keys(tools).length} 个工具`);

  const expected = [
    'memory_search', 'memory_curve_day', 'memory_curve_raw',
    'memory_curve_days', 'memory_curve_show', 'memory_curve_build',
  ];
  for (const name of expected) {
    if (!tools[name]) { say('✗', name, '没注册'); failed++; }
  }
  if (!failed) say('✓', '六个工具齐全');

  if (typeof contextText !== 'function') {
    say('✗', 'context 注入', 'text 不是函数');
    failed++;
  } else {
    const out = String(contextText());
    say('✓', 'context 求值', `${out.length} 字符`);
    if (!out.includes('记忆事件索引')) {
      say('✗', 'context 内容', '缺少标题行');
      failed++;
    }
  }

  // 工具实测：execute() 拿原始返回，再转成文本（模拟宿主流程）
  // 有 render 的走 render，没有的直接读 .text，都没有就 JSON 化
  const toText = (name, raw) => {
    const tool = tools[name];
    if (tool && typeof tool.render === 'function') {
      try {
        const parts = tool.render({}, raw);
        if (Array.isArray(parts)) {
          const joined = parts.map(p => (p && p.text) || '').filter(Boolean).join('\n');
          if (joined) return joined;
        }
      } catch { /* render 失败就退回下面的兜底 */ }
    }
    if (raw && typeof raw === 'object' && typeof raw.text === 'string') return raw.text;
    return JSON.stringify(raw);
  };

  const run = async (name, fn) => {
    try {
      const raw = await fn();
      const text = toText(name, raw);
      say('✓', name, String(text).split('\n')[0].slice(0, 62));
      return text;
    } catch (e) {
      say('✗', name, e.message.slice(0, 70));
      failed++;
      return '';
    }
  };

  await run('memory_curve_days', () => tools.memory_curve_days.execute());
  await run('memory_curve_build', () => tools.memory_curve_build.execute());
  const searchText = await run('memory_search', () => tools.memory_search.execute({ pattern: '连接池', maxHits: 3 }));
  await run('memory_curve_day', () => tools.memory_curve_day.execute({ day: '2026-01-15' }));
  await run('memory_curve_show', () => tools.memory_curve_show.execute({ level: 'T1', maxChars: 300 }));

  // raw 需要先搜出 id
  const m = searchText.match(/m_\d{8}_[0-9a-f]{6}/);
  if (m) {
    await run('memory_curve_raw', () => tools.memory_curve_raw.execute({ id: m[0], maxChars: 100 }));
  } else {
    say('✗', 'memory_curve_raw', '搜索结果里没有 id，跳过');
    failed++;
  }

  console.log('');
  if (failed) {
    console.log(`✗ ${failed} 项失败`);
  } else {
    console.log('✓ 全部通过 —— 干净环境可跑');
  }
} catch (e) {
  console.log(`✗ 致命错误: ${e.message}`);
  failed++;
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
}

process.exit(failed ? 1 : 0);