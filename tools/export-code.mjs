#!/usr/bin/env node
/**
 * 把仓库里的源码导出成一份完整的 Markdown 文档。
 *
 * 为什么要有这个脚本：`记忆插件完整代码.md` 以前是手工拼的，于是每次升级都忘了回填 ——
 * 0.5.3 的仓库里那份还停在 0.3.9。手工维护的东西一定会过期，所以改成生成。
 *
 * 输出文件的路径固定为仓库根目录的 `记忆插件完整代码.md`，并且它在 `.gitignore` 里
 * ——这是本地交付文档，不随仓库分发（别人 clone 下来看到的是各文件原文，不需要这份重复）。
 *
 * 用法：
 *   node tools/export-code.mjs
 *   node tools/export-code.mjs --out D:/somewhere/完整代码.md
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 导出顺序：清单 → 配置 → 文档 → 源码 → 工具 → CI */
const FILES = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'src/index.js',
  'src/events.js',
  'src/digest.js',
  'src/collector.js',
  'src/access.js',
  'src/paths.js',
  'tools/memory-notes.mjs',
  'tools/build-dailies.mjs',
  'tools/export-code.mjs',
  'tools/verify-ids.mjs',
  'tools/collector-test.mjs',
  'tools/collector-host-test.mjs',
  'tools/selftest.mjs',
  'tools/bench.mjs',
  'tools/check.mjs',
  '.github/workflows/ci.yml',
];

const LANG = {
  '.js': 'js',
  '.mjs': 'js',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.md': 'markdown',
  '.txt': 'text',
};

function langOf(p) {
  const i = p.lastIndexOf('.');
  return (i >= 0 && LANG[p.slice(i)]) || 'text';
}

/**
 * 围栏要比内容里最长的一串反引号更长，否则代码里含 ``` 时会被提前截断。
 * README 里就写着 ```js 的例子，用三层围栏会让整份文档从那里开始错位。
 */
function fenceFor(text) {
  let longest = 0;
  for (const m of text.match(/`+/g) || []) longest = Math.max(longest, m.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 && process.argv[outArg + 1]
  ? process.argv[outArg + 1]
  : join(ROOT, '记忆插件完整代码.md');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const entries = [];
let totalLines = 0;
for (const rel of FILES) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    console.warn(`跳过（读不到）：${rel}`);
    continue;
  }
  const body = raw.replace(/\r\n/g, '\n');
  const lines = body.split('\n').length;
  totalLines += lines;
  entries.push({ rel, body, lines });
}

const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
})();

const md = [];
md.push(`# dsh-memory-curve 完整代码 v${pkg.version}`, '');
md.push(`导出时间：${stamp}　仓库：${pkg.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '') || '-'}`, '');
md.push('> 本文件由 `tools/export-code.mjs` 生成，不要手工编辑 —— 改源码后重新跑一遍即可。', '');
md.push('## 文件清单', '');
md.push('| 文件 | 行数 |', '|---|---|');
for (const e of entries) md.push(`| \`${e.rel}\` | ${e.lines} |`);
md.push(`| **合计** | **${totalLines}** |`, '');
md.push('---', '');

for (const e of entries) {
  const fence = fenceFor(e.body);
  md.push(`## ${e.rel}`, '');
  md.push(`${fence}${langOf(e.rel)}`);
  md.push(e.body.endsWith('\n') ? e.body.slice(0, -1) : e.body);
  md.push(fence, '');
}

const text = md.join('\n');
writeFileSync(OUT, text, 'utf8');

let bytes = 0;
try { bytes = statSync(OUT).size; } catch { /* 忽略 */ }
console.log(`已导出 ${entries.length} 个文件 / ${totalLines} 行 / ${(bytes / 1024).toFixed(0)} KB`);
console.log(OUT);