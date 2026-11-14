import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createCollector, messageFromEvent, mountAutoCollector, zstdFrameLength, writeAtomic } from '../src/collector.js';
import { readEntries } from '../src/events.js';
import { buildDailies } from '../src/digest.js';

const time = new Date(2026, 0, 15, 10).getTime();
const header = { type: 'session', id: 'session-fixture', cwd: path.join(os.tmpdir(), 'fixture-work'), isSeeded: false };
const user = (seq, text = '用户原文', extra = {}) => ({ type: 'user/message', seq, time: time + seq * 1000,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, ...extra });
const assistant = (seq, text = '助手原文') => ({ type: 'assistant/message', seq, time: time + seq * 1000,
  data: { message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] } } });
const frame = (rows) => zstdCompressSync(Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n'));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.MC_SELFTEST_ROOT || os.tmpdir(), 'mc-collector-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const memDir = path.join(root, 'memory'), sessionsDir = path.join(root, 'sessions');
  const log = path.join(sessionsDir, 'work', 'session', 'session.v4.jsonl.zstd');
  await fs.mkdir(path.dirname(log), { recursive: true });
  let refreshed = [];
  const opts = { memDir, sessionsDir, onDirty: async days => { refreshed.push(...days); } };
  return { root, memDir, sessionsDir, log, opts, refreshed, collector: createCollector(opts),
    checkpoint: async () => JSON.parse(await fs.readFile(path.join(memDir, '.memory-collector', 'state.json'), 'utf8')) };
}

test('新版用户、旧版包装用户、助手正文；英文/代码/单字完整保留', () => {
  const english = 'This is a normal English conversation with code. '.repeat(10);
  assert.equal(messageFromEvent(user(1, english), header).text, english.trim());
  const old = user(2); old.data = { message: old.data };
  assert.equal(messageFromEvent(old, header).role, 'user');
  assert.equal(messageFromEvent(assistant(3, 'import x from "x";'), header).text, 'import x from "x";');
  assert.equal(messageFromEvent(user(4, '好'), header).text, '好');
});

test('思考块/工具事件/压缩替换/非真实用户消息跳过', () => {
  const a = assistant(1, '结论'); a.data.message.content.unshift({ type: 'reasoning', text: 'PRIVATE_REASONING' });
  assert.equal(messageFromEvent(a, header).text, '结论');
  assert.equal(messageFromEvent({ ...a, type: 'assistant/attempt' }, header), null);
  assert.equal(messageFromEvent({ ...a, type: 'tool/result' }, header), null);
  assert.equal(messageFromEvent({ ...a, surfaceOp: { op: 'replace' } }, header), null);
  assert.equal(messageFromEvent({ ...a, data: { ...a.data, interrupted: true } }, header), null);
  const synthetic = user(2); synthetic.data.source.kind = 'system-prompt';
  assert.equal(messageFromEvent(synthetic, header), null);
});

test('排除子代理、会话和工作目录（包含子目录）', () => {
  assert.equal(messageFromEvent(user(1), { ...header, origin: 'subagent' }), null);
  assert.ok(messageFromEvent(user(1), { ...header, origin: 'subagent' }, { includeSubagents: true }));
  assert.equal(messageFromEvent(user(1), header, { excludeSessions: header.id }), null);
  assert.equal(messageFromEvent(user(1), { ...header, cwd: path.join(header.cwd, 'child') }, { excludeCwds: header.cwd }), null);
});

test('真实多帧日志补采+摘要联动；二次运行零新增', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.log, Buffer.concat([frame([header]), frame([user(1), assistant(2)])]));
  f.opts.onDirty = async (days, memDir) => buildDailies({ memDir, digestDir: path.join(f.root, 'digest'), days });
  const c = createCollector(f.opts);
  assert.equal((await c.run()).added, 2);
  assert.equal(readEntries(f.memDir).length, 2);
  assert.equal(readEntries(f.memDir)[0].text, '用户原文');
  assert.equal((await c.run()).added, 0);
  assert.equal((await fs.readdir(path.join(f.root, 'digest'))).length, 2);
  assert.equal((await f.checkpoint()).files[f.log].offset, (await fs.stat(f.log)).size);
});

test('只读取新增尾部，重启后继续检查点', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.log, frame([header, user(1)]));
  await f.collector.run();
  await fs.appendFile(f.log, frame([assistant(2)]));
  const restarted = createCollector(f.opts);
  assert.equal((await restarted.run()).added, 1);
  assert.equal(readEntries(f.memDir).length, 2);
});

test('半截 zstd 尾帧等待下次；检查点不越过坏尾部', async t => {
  const f = await fixture(t);
  const first = frame([header, user(1)]), tail = frame([assistant(2)]);
  await fs.writeFile(f.log, Buffer.concat([first, tail.subarray(0, tail.length - 4)]));
  assert.equal((await f.collector.run()).added, 1);
  assert.equal((await f.checkpoint()).files[f.log].offset, first.length);
  await fs.appendFile(f.log, tail.subarray(tail.length - 4));
  assert.equal((await f.collector.run()).added, 1);
});

test('JSON 行可跨帧且中文 UTF8 可跨帧', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from(JSON.stringify(user(1, '正文鲸鱼尾巴')) + '\n');
  const split = bytes.indexOf(Buffer.from('鲸')) + 1;
  const h = frame([header]);
  await fs.writeFile(f.log, Buffer.concat([h, zstdCompressSync(bytes.subarray(0, split))]));
  assert.equal((await f.collector.run()).added, 0);
  assert.equal((await f.checkpoint()).files[f.log].offset, h.length);
  await fs.appendFile(f.log, zstdCompressSync(bytes.subarray(split)));
  assert.equal((await f.collector.run()).added, 1);
  assert.equal(readEntries(f.memDir)[0].text, '正文鲸鱼尾巴');
});

test('压缩体内含魔数不被误切；skippable 帧正常跳过', () => {
  // Raw Zstandard block containing the magic bytes inside its payload.
  const payload = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 97, 98]);
  const raw = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 6, 49, 0, 0]), payload]);
  assert.equal(zstdFrameLength(raw).length, raw.length);
  const skip = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 1, 2]);
  assert.deepEqual(zstdFrameLength(skip), { length: 10, skip: true });
});

test('写完流水但检查点失败：重启重放不会重复，待刷新仍可恢复', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.log, frame([header, user(1), assistant(2)]));
  const broken = createCollector({ ...f.opts, fault: async at => { if (at === 'after-data') throw new Error('simulated crash'); } });
  await assert.rejects(broken.run(), /simulated crash/);
  assert.equal(readEntries(f.memDir).length, 2);
  assert.deepEqual((await f.checkpoint()).files, {});
  assert.deepEqual((await f.checkpoint()).dirtyDays, ['2026-01-15']);
  assert.equal((await createCollector(f.opts).run()).added, 0);
  assert.equal(readEntries(f.memDir).length, 2);
  assert.equal((await f.checkpoint()).dirtyDays.length, 0);
});

test('摘要失败不重采流水，下一次刷新恢复', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.log, frame([header, user(1)]));
  const c = createCollector({ ...f.opts, onDirty: async () => { throw new Error('digest locked'); } });
  await assert.rejects(c.run(), /digest locked/);
  assert.equal((await f.checkpoint()).files[f.log].offset, (await fs.stat(f.log)).size);
  assert.equal((await createCollector(f.opts).run()).added, 0);
  assert.equal(f.refreshed.length, 1);
});

test('完整坏帧/坏 JSON 会报错且游标不前进', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.log, Buffer.from('broken zstd data'));
  await assert.rejects(f.collector.run(), /magic/);
  await fs.writeFile(f.log, zstdCompressSync(Buffer.from('not valid json\n')));
  await assert.rejects(f.collector.run(), SyntaxError);
});

test('手写前后缀、旧流水/锚点保留；含 AUTO 标记的正文不会破坏结构', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.memDir, { recursive: true });
  const dayFile = path.join(f.memDir, '2026-01-15.md');
  const legacyText = '旧消息';
  const id = 'm_20260115_' + createHash('sha1').update(legacyText).digest('hex').slice(0, 6);
  const old = `手工前缀\r\n<!-- dsh-note:auto-begin:7f3a -->\n2026-01-15 10:00 ［小鱼］ <!-- ${id} -->\n${legacyText}\n<!-- dsh-note:auto-end:7f3a -->\r\n手工后缀`;
  await fs.writeFile(dayFile, old);
  await fs.writeFile(f.log, frame([header, assistant(1, legacyText), user(2, '<!-- dsh-note:auto-end:7f3a -->\n保存标记') ]));
  assert.equal((await f.collector.run()).added, 1);
  const out = await fs.readFile(dayFile, 'utf8');
  assert.ok(out.startsWith('手工前缀\r\n'));
  assert.ok(out.endsWith('\r\n手工后缀'));
  assert.ok(out.includes(id));
  assert.equal(out.split('<!-- dsh-note:auto-end:7f3a -->').length, 2);
});

test('新事件同一句话重复说两次会保留；同一个事件重放只存一次', async t => {
  const f = await fixture(t);
  const live = [1, 2].map(seq => ({ header, event: user(seq, '同一句话') }));
  assert.equal((await f.collector.run({ live, scan: false })).added, 2);
  assert.equal((await f.collector.run({ live, scan: false })).added, 0);
  assert.equal(readEntries(f.memDir).length, 2);
});

test('实时事件早于磁盘 backlog 提交时仍补齐旧消息', async t => {
  const f = await fixture(t);
  await f.collector.run({ scan: false, live: [{ header, event: assistant(10) }] });
  await fs.writeFile(f.log, frame([header, user(1), assistant(10)]));
  assert.equal((await f.collector.run()).added, 1);
  assert.equal(readEntries(f.memDir).length, 2);
});

test('排除 seeded 继承记录；只采 session/end-seed 后的内容', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.log, frame([{ ...header, isSeeded: true }, user(1, '继承内容'), { type: 'session/end-seed', seq: 2 }, user(3, '自己新说的')]));
  assert.equal((await f.collector.run()).added, 1);
  assert.equal(readEntries(f.memDir)[0].text, '自己新说的');
});

test('两个 writer 互斥；失败后释放锁', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.log, frame([header, user(1)]));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const active = new Promise(resolve => { entered = resolve; });
  const c = createCollector({ ...f.opts, fault: async at => { if (at === 'after-data') { entered(); await gate; } } });
  const run = c.run(); await active;
  await assert.rejects(createCollector(f.opts).run(), e => e.code === 'ELOCKED');
  release(); await run;
  assert.equal((await createCollector(f.opts).run()).added, 0);
});

test('缺日志目录为空运行，坏 AUTO/坏状态保留原件并报错', async t => {
  const f = await fixture(t);
  assert.equal((await createCollector({ ...f.opts, sessionsDir: path.join(f.root, 'missing') }).run()).added, 0);
  const badDay = path.join(f.memDir, '2026-01-15.md');
  await fs.writeFile(badDay, '<!-- dsh-note:auto-begin:7f3a -->\n手写内容');
  const before = await fs.readFile(badDay, 'utf8');
  await assert.rejects(f.collector.run({ scan: false, live: [{ header, event: user(1) }] }), /Malformed AUTO/);
  assert.equal(await fs.readFile(badDay, 'utf8'), before);
});

test('输出目录切换后独立补采，旧目录不重写', async t => {
  const f = await fixture(t); let dir = f.memDir;
  const c = createCollector({ ...f.opts, memDir: () => dir });
  await fs.writeFile(f.log, frame([header, user(1)]));
  await c.run(); const old = (await fs.stat(path.join(dir, '2026-01-15.md'))).mtimeMs;
  dir = path.join(f.root, 'memory2'); await c.run();
  assert.equal(readEntries(dir).length, 1);
  assert.equal((await fs.stat(path.join(f.memDir, '2026-01-15.md'))).mtimeMs, old);
});

test('事件适配器异步排队、flush、卸载监听与定时器', async t => {
  const f = await fixture(t); let listener, removed = false;
  const ctx = { on: (name, fn) => { assert.equal(name, 'session/event'); listener = fn; return () => { removed = true; }; } };
  const auto = mountAutoCollector(ctx, { ...f.opts, flushMs: 100000, scanMs: 100000 });
  t.after(() => auto.dispose());
  listener({ header, id: header.id, isOwnSeq: () => true }, user(1));
  assert.equal(readEntries(f.memDir).length, 0);
  assert.equal((await auto.flush()).added, 1);
  auto.dispose(); assert.ok(removed);
  listener({ header, id: header.id }, user(2));
  assert.equal(readEntries(f.memDir).length, 1);
});

test('原子替换写入失败时原路径保持，临时文件清理', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'existing-directory');
  await fs.mkdir(target);
  await assert.rejects(writeAtomic(target, 'new bytes'));
  assert.ok((await fs.stat(target)).isDirectory());
  assert.equal((await fs.readdir(f.root)).filter(n => n.endsWith('.tmp')).length, 0);
});
