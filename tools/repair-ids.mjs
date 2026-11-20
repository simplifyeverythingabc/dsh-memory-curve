#!/usr/bin/env node
/**
 * Repair legacy content-only duplicate memory IDs.
 *
 * Dry run is the default. Pass --apply to rewrite only duplicate header anchors;
 * each changed day is copied to <day>.repair-backup-<timestamp> before replacement.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveMemDir } from '../src/paths.js';

const HEAD = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})\s+［(.+?)］(?:\s*<!--\s*(m_[0-9]{8}_[0-9a-f]{6})\s*-->)?\s*$/;
const memDir = resolveMemDir();
const apply = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backupDir = process.env.MC_REPAIR_BACKUP_DIR || memDir;
const outputDir = process.env.MC_REPAIR_OUTPUT_DIR || '';
if (apply) mkdirSync(backupDir, { recursive: true });
if (apply && outputDir) mkdirSync(outputDir, { recursive: true });
const changed = [];
let duplicateCount = 0;

function uniqueId(original, entry, ordinal, used) {
  let salt = 0;
  let id;
  do {
    const key = `${original}\0${entry.day} ${entry.hhmm}\0${entry.who}\0${entry.body}\0${ordinal}\0${salt++}`;
    id = `m_${entry.day.replace(/-/g, '')}_${createHash('sha1').update(key).digest('hex').slice(0, 6)}`;
  } while (used.has(id));
  return id;
}

function repairFile(file) {
  const original = readFileSync(file, 'utf8');
  const lines = original.split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = HEAD.exec(line.replace(/\r$/, ''));
    if (m) {
      if (cur) blocks.push(cur);
      cur = { header: line, day: m[1], hhmm: `${m[2]}:${m[3]}`, who: m[4], id: m[5], body: [] };
    } else if (cur) cur.body.push(line);
  }
  if (cur) blocks.push(cur);
  const counts = new Map();
  const used = new Set(blocks.map((b) => b.id).filter(Boolean));
  let duplicates = 0;
  for (const b of blocks) {
    if (!b.id) continue;
    const ordinal = (counts.get(b.id) || 0) + 1;
    counts.set(b.id, ordinal);
    if (ordinal === 1) continue;
    const old = b.id;
    b.id = uniqueId(old, { ...b, body: b.body.join('\n').trim() }, ordinal, used);
    used.add(b.id);
    b.header = `${b.day} ${b.hhmm} ［${b.who}］ <!-- ${b.id} -->${b.header.endsWith('\r') ? '\r' : ''}`;
    duplicates++;
    duplicateCount++;
    console.log(`${file}: ${old} -> ${b.id}`);
  }
  if (!duplicates) return;
  changed.push({ file, duplicates });
  if (!apply) return;
  const backup = join(backupDir, `${basename(file)}.repair-backup-${stamp}`);
  copyFileSync(file, backup);
  const out = [];
  let blockIndex = 0;
  for (const line of lines) {
    const m = HEAD.exec(line.replace(/\r$/, ''));
    if (m) out.push(blocks[blockIndex++].header);
    else out.push(line);
  }
  const target = outputDir ? join(outputDir, basename(file)) : file;
  const tmp = `${target}.repair-tmp-${process.pid}`;
  writeFileSync(tmp, out.join('\n'), 'utf8');
  renameSync(tmp, target);
  console.log(`写入 ${target}，备份 ${backup}`);
}

if (!statSync(memDir, { throwIfNoEntry: false })) {
  console.error(`流水目录不存在：${memDir}`);
  process.exit(1);
}
for (const name of readdirSync(memDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x)).sort()) {
  repairFile(join(memDir, name));
}
console.log(`重复 ID ${duplicateCount} 处，涉及 ${changed.length} 个日期文件。`);
if (!apply && duplicateCount) console.log('当前为预览模式；确认备份后用 --apply 写回。');
