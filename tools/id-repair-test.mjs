#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEntries } from '../src/events.js';

const root = mkdtempSync(join(process.env.MC_ID_TEST_ROOT || tmpdir(), 'mc-id-'));
try {
  const day = join(root, '2026-01-01.md');
  mkdirSync(root, { recursive: true });
  const id = 'm_20260101_aaaaaa';
  writeFileSync(day, [
    `2026-01-01 10:00 ［用户］ <!-- ${id} -->`, '重复一', '',
    `2026-01-01 10:01 ［用户］ <!-- ${id} -->`, '重复二', '',
    `2026-01-01 10:02 ［用户］ <!-- ${id} -->`, '重复三', '',
  ].join('\n'), 'utf8');
  const entries = readEntries(root);
  const ids = entries.map((x) => x.id);
  if (entries.length !== 3 || new Set(ids).size !== 3 || ids[0] !== id) throw new Error(`ID normalization failed: ${JSON.stringify(ids)}`);
  console.log('ID repair test: 3 unique IDs; first legacy ID preserved');
} finally {
  rmSync(root, { recursive: true, force: true });
}
