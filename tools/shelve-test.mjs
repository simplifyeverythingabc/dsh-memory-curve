/**
 * 沉底功能测试（0.17.0）
 *
 * 验四件事，缺一件就不算完：
 *   ① 沉底后，注入里不再出现这条
 *   ② 注入体积确实变小了
 *   ③ memory_search 还能搜到它（**这是关键 —— 沉底不是删除**）
 *   ④ 捞回来之后，注入里又有了
 *
 * 跑：node tools/shelve-test.mjs
 */
import { apply, build } from '../src/index.js';
import { clearClusterCache } from '../src/events.js';
import { shelve } from '../src/access.js';
import { searchAll } from '../src/digest.js';
import { dshHome, resolveMemDir } from '../src/paths.js';
import { join } from 'node:path';

const access = join(dshHome(), 'memory-notes', '_access.json');
const memDir = resolveMemDir();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('    PASS  ' + name); } else { fail += 1; console.log('    FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

const grab = () => {
  let cap = null;
  const stub = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'effect') return (fn) => { try { fn(); } catch { /* 忽略 */ } };
      if (k === 'systemPrompt') return { context: (o) => { try { cap = o.text(); } catch { cap = ''; } } };
      if (k === 'tools') return { register: () => {} };
      return () => undefined;
    },
  });
  apply(stub, {});
  return cap;
};

console.log('');
const before = grab();
ok('能拿到注入正文', typeof before === 'string' && before.length > 0, '长度 ' + (before || '').length);

clearClusterCache();
const graded = build().graded;

// 挑一个「当前在注入里、有 id」的事件做实验。优先 L2（最可能在注入里）。
const victim = graded.find((x) => x.level === 'L2' && x.ids && x.ids.length && before.includes(String(x.head || '').slice(0, 12)))
  || graded.find((x) => x.ids && x.ids.length);
if (!victim) {
  console.log('  找不到试验对象（语料里没有带 id 的事件）');
  process.exit(1);
}
const vids = victim.ids.slice();
const vhead = String(victim.head || '').slice(0, 30);
const marker = String(victim.head || '').slice(0, 12);
console.log(`  试验对象: ${vhead}`);
console.log(`           ${vids.length} 个 id, ${victim.level}`);
console.log(`  沉底前注入: ${before.length} 字符`);
console.log('');

// ── 沉底 ──
const r = shelve(access, vids, true, '自动化测试', Date.now());
ok('shelve 写入成功', r.shelved === vids.length, `${r.shelved}/${vids.length}`);

clearClusterCache();
const after = grab();
ok('沉底后注入变短', after.length < before.length, `${before.length} → ${after.length}`);
ok('注入里不再出现这条', !after.includes(marker), '仍然包含「' + marker + '」');
ok('省下的字符数 > 0', before.length - after.length > 0, String(before.length - after.length));

// ── 搜索仍可达（沉底 ≠ 删除）──
const q = marker.replace(/\s/g, '');
const s = q.length >= 2 ? searchAll({ memDir, pattern: q, maxHits: 10 }) : { hits: [] };
const found = (s.hits || []).some((h) => vids.includes(h.id));
ok('memory_search 仍能搜到（沉底不是删除）', found, '搜「' + q + '」没命中');

// ── 捞回 ──
shelve(access, vids, false, '', Date.now());
clearClusterCache();
const back = grab();
// 别拿绝对长度比 —— 测试期间可能正好有新消息落盘（这场就撞上了，3517 条），
// 长度会因为新增事件浮动。要验的是「比沉底状态长」且「这条回来了」。
ok('捞回后注入比沉底时更长', back.length > after.length, `${after.length} → ${back.length}`);
ok('捞回后注入里又有它', back.includes(marker), '没回来');

console.log('');
console.log(`  ══════ ${pass} 通过 / ${fail} 失败 ══════`);
process.exit(fail ? 1 : 0);
