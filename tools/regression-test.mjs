#!/usr/bin/env node
/**
 * 回归：历史重复 ID、跨日期伪头部、CJK 无空格查询、摘要正文不含标记。
 * 夹具全部写在临时目录，不碰真实记忆。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEntries } from '../src/events.js';
import { searchAll, buildDailies } from '../src/digest.js';

const root = mkdtempSync(join(process.env.MC_REGRESSION_ROOT || tmpdir(), 'mc-regression-'));
const mem = join(root, 'memory');
const dig = join(root, 'digest');
mkdirSync(mem, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, note = '') => { pass++; console.log(`  PASS ${name}${note ? ' · ' + note : ''}`); };
const bad = (name, note = '') => { fail++; console.log(`  FAIL ${name}${note ? ' · ' + note : ''}`); };
const check = (name, cond, note = '') => (cond ? ok(name, note) : bad(name, note));

try {
  const dup = 'm_20260101_aaaaaa';
  writeFileSync(join(mem, '2026-01-01.md'), [
    `2026-01-01 10:00 ［用户］ <!-- ${dup} -->`, '同一句', '',
    `2026-01-01 10:01 ［用户］ <!-- ${dup} -->`, '同一句', '',
    `2026-01-01 10:02 ［用户］ <!-- ${dup} -->`, '同一句', '',
  ].join('\n'), 'utf8');
  const e1 = readEntries(mem).filter((x) => x.day === '2026-01-01');
  check('重复 ID 归一化', e1.length === 3 && new Set(e1.map((x) => x.id)).size === 3, e1.map((x) => x.id).join(','));
  check('首条旧 ID 保留', e1[0].id === dup, e1[0].id);

  // 当天正文里引用另一天的头部行（无锚点）必须当正文，不能变成新事件
  writeFileSync(join(mem, '2026-01-02.md'), [
    '2026-01-02 09:00 ［助手］ <!-- m_20260102_bbbbbb -->',
    '对话里贴了一段旧记录：',
    '2026-01-01 10:00 ［用户］',
    '这一行不该变成 01-01 的新条目',
  ].join('\n'), 'utf8');
  const e2 = readEntries(mem).filter((x) => x.day === '2026-01-02');
  check('跨日期伪头部不分裂', e2.length === 1, `entries=${e2.length}`);
  check('伪头部留在正文里', (e2[0]?.text || '').includes('2026-01-01 10:00 ［用户］'));

  // 中文无空格查询要走二元切分召回
  writeFileSync(join(mem, '2026-01-03.md'), [
    '2026-01-03 11:00 ［用户］ <!-- m_20260103_cccccc -->',
    '缓存失效的排查记录：先看命中率，再看穿透',
  ].join('\n'), 'utf8');
  const r = searchAll({ memDir: mem, pattern: '缓存排查记录', maxHits: 5 });
  check('CJK 无空格查询可召回', r.total > 0 || r.mode === 'CJK-BIGRAM', `total=${r.total} mode=${r.mode}`);

  // 摘要正文不能带 memory-source 或 AUTO 标记
  const built = buildDailies({ memDir: mem, digestDir: dig });
  check('摘要生成', built.written.length >= 1, `${built.written.length} 天`);
  const text = readFileSync(join(dig, '2026-01-03.md'), 'utf8');
  check('摘要不含内部标记', !/memory-source|dsh-note:auto/.test(text));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n回归 ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;