import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { apply, Config } from '../src/index.js';
import { readEntries } from '../src/events.js';

const header = { id: 'host-test', cwd: 'C:/host-test', isSeeded: false };
const user = (seq, text) => ({ type: 'user/message', seq, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text }] } });

test('自动采集 Config 完整，缺省保持关闭', () => {
  for (const key of ['autoCollect', 'collectSubagents', 'collectExcludeCwds', 'collectExcludeSessions', 'collectFlushMs', 'collectScanMs', 'collectSummaryMs']) assert.ok(Config.dict[key], key);
  assert.equal(Config.dict.autoCollect.meta.default, false);
  assert.equal(Config.dict.collectSubagents.meta.default, false);
});

test('插件真实 apply 接线：消息事件 -> 异步落盘 -> 摘要 -> 上下文 -> 卸载', async () => {
  const root = await fs.mkdtemp(path.join(process.env.MC_SELFTEST_ROOT || os.tmpdir(), 'mc-host-'));
  const saved = { DSH_HOME: process.env.DSH_HOME, DSH_MEMORY_DIR: process.env.DSH_MEMORY_DIR };
  process.env.DSH_HOME = path.join(root, 'home');
  process.env.DSH_MEMORY_DIR = path.join(root, 'memory');
  const listeners = new Map(), disposers = [], contexts = [], tools = new Map();
  const ctx = {
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d; },
    systemPrompt: { context(def) { contexts.push(def); return () => {}; } },
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name); } },
  };
  try {
    apply(ctx, { autoCollect: true, collectFlushMs: 100, collectScanMs: 1000, collectSummaryMs: 100 });
    assert.equal(tools.size, 6);
    assert.ok(listeners.has('session/event'));
    const session = { id: 'host-test', header: { cwd: root }, isOwnSeq: () => true };
    const time = new Date(2026, 0, 15, 10).getTime();
    const emit = listeners.get('session/event');
    emit(session, { type: 'user/message', seq: 1, time, data: { role: 'user', content: [{ type: 'text', text: '用户的问题：自动采集真的生效吗？' }] } });
    emit(session, { type: 'assistant/message', seq: 2, time: time + 1000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '回答：现在完整落盘并刷新摘要。' }] } } });
    assert.equal(readEntries(process.env.DSH_MEMORY_DIR).length, 0);
    const seededSession = { header: { ...header, isSeeded: true }, id: header.id, isOwnSeq: () => true };
    emit(seededSession, user(3, '继承来的实时内容'));
    assert.equal(readEntries(process.env.DSH_MEMORY_DIR).length, 0);
    const checkpoint = path.join(process.env.DSH_MEMORY_DIR, '.memory-collector', 'state.json');
    const until = Date.now() + 5000;
    let state;
    while (Date.now() < until) {
      try { state = JSON.parse(await fs.readFile(checkpoint, 'utf8')); } catch { /* wait for atomic commit */ }
      if (state?.done['host-test'] === 2 && state.dirtyDays.length === 0) break;
      await delay(20);
    }
    assert.equal(state?.done['host-test'], 2);
    assert.equal(state.dirtyDays.length, 0);
    assert.equal(readEntries(process.env.DSH_MEMORY_DIR).length, 2);
    const digest = await fs.readFile(path.join(process.env.DSH_HOME, 'memory-notes', '_digest', '2026-01-15.md'), 'utf8');
    assert.ok(digest.includes('自动采集'));
    const prompt = contexts[0].text();
    assert.ok(prompt.includes('2 条'));
    assert.ok(prompt.includes('自动采集：已启用'));
    assert.ok(!prompt.includes('等待首次完成'));
  } finally {
    for (const dispose of disposers.reverse()) dispose();
    assert.equal(listeners.size, 0);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('disabled=true 时自动采集同样跳过全部注册', () => {
  apply({ effect() { assert.fail('disabled plugin must not register effects'); } }, { disabled: true, autoCollect: true });
});
