// 语法检查：扫目录，不写死文件列表。
//
// 为什么不用 `node --check a.js && node --check b.js ...`：
// 加文件必忘。这次就烂在这上面 —— src/paths.js 建好之后 check 脚本里没有它，
// 本地跑 npm run check 全绿，实际上新文件一个语法字符都没检查过。
//
// 为什么不用 shell 的 for 循环：npm 在 Windows 上默认走 cmd，
// `for f in src/*.js` 是 bash 语法，换台机器就炸。
import { readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = [
  { dir: 'src', ext: '.js' },
  { dir: 'tools', ext: '.mjs' },
];

const targets = [];
for (const { dir, ext } of SCAN) {
  let names;
  try { names = readdirSync(join(root, dir)); } catch { continue; }
  for (const name of names.sort()) {
    if (!name.endsWith(ext)) continue;
    if (name.includes('.bak-')) continue;      // 备份文件不检查
    const p = join(root, dir, name);
    try { if (!statSync(p).isFile()) continue; } catch { continue; }
    targets.push(p);
  }
}

if (targets.length === 0) {
  console.error('没找到要检查的文件 —— 目录结构可能变了');
  process.exit(1);
}

// 只防「0 个文件」不够：目录改名、后缀改了，会扫到 1 个文件并全绿。
// 断言几个必需文件在不在，比断言数字稳 —— 数字会过期，文件名不会。
const REQUIRED = [
  'src/index.js', 'src/events.js', 'src/digest.js', 'src/access.js', 'src/paths.js',
  'tools/check.mjs', 'tools/selftest.mjs', 'tools/verify-ids.mjs',
  // build-dailies 比 bench 更核心：apply 启动时就会调 buildDailies，它坏了主链路掉一半
  'tools/memory-notes.mjs', 'tools/build-dailies.mjs', 'tools/bench.mjs',
];
const missing = REQUIRED.filter((r) => !targets.some((p) => p.replace(/\\/g, '/').endsWith(r)));
if (missing.length) {
  console.error(`缺少必需文件，检查目录结构：${missing.join(', ')}`);
  process.exit(1);
}

let bad = 0;
for (const p of targets) {
  const rel = relative(root, p).replace(/\\/g, '/');
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    console.log(`  ok   ${rel}`);
  } catch (e) {
    bad++;
    const msg = String(e.stderr || e.message).split('\n').slice(0, 4).join('\n');
    console.error(`  FAIL ${rel}`);
    console.error(msg);
  }
}

console.log(`\n${targets.length} 个文件，${bad} 个失败`);
process.exitCode = bad ? 1 : 0;
