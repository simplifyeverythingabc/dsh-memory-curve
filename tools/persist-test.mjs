/**
 * persist.js 的边界回归（0.14.3+）
 *
 * 这一层出过一次很贵的错：0.14.0 漏存 toks/entities，导致热启动分级全塌 L5，
 * 而且**不报错**——数量全对、内容全错，骗过了三次验收。
 *
 * 所以这个文件专测「会静默算错」的地方：
 *   · 存下去的东西能不能原样读回来
 *   · 索引坏了会不会静默用
 *   · 语料缩水（entryCount 越界）会不会越界切片
 *   · 各种半截 JSON 会不会抛异常
 *
 * 跑：node tools/persist-test.mjs
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEntries, clusterEvents, clearEntryCache, clearClusterCache } from '../src/events.js';
import { scanFiles, planReuse, loadIndex, saveIndex } from '../src/persist.js';

const DIR = join(tmpdir(), `dsh-persist-test-${process.pid}`);
const IDX = join(DIR, '_events.json');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('    PASS  ' + name); } else { fail += 1; console.log('    FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

// 必须匹配 events.js 里的 DAY_RE：
//   /^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s+［(.+?)］(?:...)?\s*$/
// 注意是**全角**方括号 —— 半角不匹配，会被整天跳过（测试夹具踩过这个坑）。
const mkMd = (day, msgs) => msgs.map((m, i) => `${day} ${String(12 + i).padStart(2, '0')}:00 ［用户］\n${m}`).join('\n\n') + '\n';
const reset = () => { clearEntryCache(); clearClusterCache(); if (existsSync(IDX)) unlinkSync(IDX); };

mkdirSync(DIR, { recursive: true });

console.log('  ── 1. 空语料 ──');
reset();
const e0 = readEntries(DIR);
ok('readEntries 空目录返回 []', Array.isArray(e0) && e0.length === 0);
ok('loadIndex 无文件返回 null', loadIndex(IDX) === null);
ok('planReuse(空,空) = full', planReuse({}, {}).mode === 'full');
ok('loadIndex 空目录 → null', loadIndex(join(DIR, 'nonexistent.json')) === null);

console.log('  ── 2. 单日单条往返 ──');
writeFileSync(join(DIR, '2026-11-10.md'), mkMd('2026-11-10', ['第一条测试消息内容，用来验证存盘往返']));
reset();
const e1 = readEntries(DIR);
const ev1 = clusterEvents(e1);
ok('单条 → 1 事件', ev1.length === 1);
ok('startIdx=0 endIdx=0', ev1[0].startIdx === 0 && ev1[0].endIdx === 0);
const toksBefore = ev1[0].toks.size;
ok('原始事件有 toks', toksBefore > 0, 'toks=' + toksBefore);

saveIndex(IDX, scanFiles(DIR), ev1, e1.length);
const i1 = loadIndex(IDX);
ok('往返成功', i1 !== null);
ok('toks 数量一致', i1.events[0].toks.size === toksBefore, `${i1.events[0].toks.size} vs ${toksBefore}`);
ok('startIdx/endIdx 保留', i1.events[0].startIdx === 0 && i1.events[0].endIdx === 0);
ok('texts 为空（等重建）', i1.events[0].texts.length === 0);
ok('items 为空（等重建）', i1.events[0].items.length === 0);

console.log('  ── 3. planReuse 判定 ──');
writeFileSync(join(DIR, '2026-11-11.md'), mkMd('2026-11-11', ['第二天消息']));
const plan1 = planReuse(i1.files, scanFiles(DIR));
ok('末尾新增一天 → tail', plan1.mode === 'tail', plan1.mode);
ok('tailFromDay 正确', plan1.tailFromDay === '2026-11-11', plan1.tailFromDay);

const snapA = { '2026-11-10.md': { size: 1, mtimeMs: 1 }, '2026-11-11.md': { size: 1, mtimeMs: 1 } };
ok('同快照 → none', planReuse(snapA, snapA).mode === 'none');
const snapMid = { '2026-11-10.md': { size: 2, mtimeMs: 2 }, '2026-11-11.md': { size: 1, mtimeMs: 1 } };
ok('中间天变了 → full', planReuse(snapA, snapMid).mode === 'full');
const snapTail = { '2026-11-10.md': { size: 1, mtimeMs: 1 }, '2026-11-11.md': { size: 2, mtimeMs: 2 } };
ok('末尾天变了 → tail', planReuse(snapA, snapTail).mode === 'tail');
ok('文件被删 → full', planReuse(snapA, { '2026-11-11.md': { size: 1, mtimeMs: 1 } }).mode === 'full');
ok('cached 为 null → full', planReuse(null, snapA).mode === 'full');
ok('current 为空 → full', planReuse(snapA, {}).mode === 'full');

console.log('  ── 4. entryCount 越界（语料缩水）──');
const realEntries = readEntries(DIR);
const badSeed = { entryCount: realEntries.length + 100, events: i1.events };
clearClusterCache();
const evBig = clusterEvents(realEntries, { seed: badSeed });
ok('seed 越界不崩', Array.isArray(evBig) && evBig.length > 0);
const textTotal = evBig.reduce((a, e) => a + (e.texts ? e.texts.length : 0), 0);
ok('退回全量后 texts 完整', textTotal > 0, 'texts 总条数=' + textTotal);
const tokTotal = evBig.reduce((a, e) => a + (e.toks ? e.toks.size : 0), 0);
ok('退回全量后 toks 完整', tokTotal > 0, 'toks 总数=' + tokTotal);

console.log('  ── 5. 正常 seed 复用 ──');
clearClusterCache();
const evSeed = clusterEvents(realEntries, { seed: { entryCount: realEntries.length, events: ev1 } });
ok('正常 seed 不崩', Array.isArray(evSeed) && evSeed.length > 0);
ok('seed 复用的部分 toks 仍在', evSeed.some((e) => e.toks && e.toks.size > 0));

console.log('  ── 6. 坏索引必须静默拒绝 ──');
const badCases = {
  '空文件': '',
  '非 JSON': 'not json at all',
  '缺 _v': JSON.stringify({ events: [], entryCount: 0, files: {} }),
  '_v=1（旧版本）': JSON.stringify({ _v: 1, events: [{ toks: [] }], entryCount: 1, files: {} }),
  '_v=99（未来）': JSON.stringify({ _v: 99, events: [{ toks: [] }], entryCount: 1, files: {} }),
  'events 非数组': JSON.stringify({ _v: 2, events: {}, entryCount: 1, files: {} }),
  'events 为空数组': JSON.stringify({ _v: 2, events: [], entryCount: 1, files: {} }),
  'toks 缺失': JSON.stringify({ _v: 2, events: [{ day: 'x' }], entryCount: 1, files: {} }),
  'toks 是对象': JSON.stringify({ _v: 2, events: [{ toks: {} }], entryCount: 1, files: {} }),
  'toks 是字符串': JSON.stringify({ _v: 2, events: [{ toks: 'abc' }], entryCount: 1, files: {} }),
  'files 缺失': JSON.stringify({ _v: 2, events: [{ toks: [] }], entryCount: 1 }),
  'entryCount 非整数': JSON.stringify({ _v: 2, events: [{ toks: [] }], entryCount: 1.5, files: {} }),
  'entryCount 是字符串': JSON.stringify({ _v: 2, events: [{ toks: [] }], entryCount: '5', files: {} }),
  '截断的 JSON': '{"_v":2,"events":[{"toks":[]}],"entryCount"',
};
for (const [name, content] of Object.entries(badCases)) {
  writeFileSync(IDX, content);
  let r = null;
  let threw = null;
  try { r = loadIndex(IDX); } catch (e) { threw = e.message; }
  ok(`坏索引「${name}」→ null 且不抛`, r === null && threw === null, threw ? '抛了: ' + threw : '返回了对象');
}

console.log('  ── 7. saveIndex 的容错 ──');
ok('父目录不存在也能写', (() => {
  const deep = join(DIR, 'a', 'b', 'c', 'idx.json');
  const r = saveIndex(deep, {}, [], 0);
  return r === true && existsSync(deep);
})());
ok('events 为空数组也能写', saveIndex(IDX, {}, [], 0) === true);

console.log('  ── 8. 只读一遍磁盘：saveIndex 不会改入参 ──');
const before = JSON.stringify(ev1.map((e) => ({ d: e.day, t: [...e.toks].length })));
saveIndex(IDX, scanFiles(DIR), ev1, realEntries.length);
const after = JSON.stringify(ev1.map((e) => ({ d: e.day, t: [...e.toks].length })));
ok('saveIndex 不改原事件', before === after);

rmSync(DIR, { recursive: true, force: true });

console.log('');
console.log(`  ══════ ${pass} 通过 / ${fail} 失败 ══════`);
process.exit(fail ? 1 : 0);
