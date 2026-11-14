// 语法检查：扫目录，不写死文件列表。
//
// 为什么不用 `node --check a.js && node --check b.js ...`：
// 加文件必忘。这次就烂在这上面 —— src/paths.js 建好之后 check 脚本里没有它，
// 本地跑 npm run check 全绿，实际上新文件一个语法字符都没检查过。
//
// 为什么不用 shell 的 for 循环：npm 在 Windows 上默认走 cmd，
// `for f in src/*.js` 是 bash 语法，换台机器就炸。
import { readdirSync, statSync, readFileSync } from 'node:fs';
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
  'src/index.js', 'src/events.js', 'src/digest.js', 'src/access.js', 'src/paths.js', 'src/collector.js',
  'tools/collector-test.mjs', 'tools/collector-host-test.mjs',
  'tools/check.mjs', 'tools/selftest.mjs', 'tools/verify-ids.mjs',
  // build-dailies 比 bench 更核心：apply 启动时就会调 buildDailies，它坏了主链路掉一半
  'tools/memory-notes.mjs', 'tools/build-dailies.mjs', 'tools/bench.mjs',
];
const missing = REQUIRED.filter((r) => !targets.some((p) => p.replace(/\\/g, '/').endsWith(r)));
if (missing.length) {
  console.error(`缺少必需文件，检查目录结构：${missing.join(', ')}`);
  process.exit(1);
}

// CHANGELOG 结构自检。
//
// 起因：连续两轮用 PowerShell here-string 生成 CHANGELOG，双引号 here-string 里
// 反引号是转义符 —— `buildDailies 的 b 变成退格(0x08)、`toISOString 的 t 变成
// TAB、`verify-ids 的 v 变成 VT，肉眼看着像拼写错误，其实是控制字节。同一批
// 编辑还把新版本节 prepend 到了 `# Changelog` 之前。加断言挡住这类复发。
//
// 与最初手写版的差别：加「# Changelog 唯一」与「控制字符范围含 0x08/0x0E-0x1F」
// 两条。后者是上一版共有的盲区 —— 退格恰好落在 0x08，原断言从 0x00 查到 0x08 时
// 写成了 0x00-0x00 段就漏了它。合法空白 TAB(0x09)、LF(0x0A) 不在检查范围。
{
  let cl = null;
  try { cl = readFileSync(join(root, 'CHANGELOG.md'), 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (cl !== null) {
    const norm = cl.replace(/\r\n/g, '\n');      // 先归一化行尾，CRLF 不算脏
    const lines = norm.split('\n');
    const problems = [];
    const firstHeading = lines.find((l) => /^#+ /.test(l)) || '（空文件）';
    if (firstHeading !== '# Changelog') problems.push(`第一个标题是「${firstHeading}」，应为「# Changelog」`);
    const titleCount = lines.filter((l) => l === '# Changelog').length;
    if (titleCount !== 1) problems.push(`「# Changelog」出现 ${titleCount} 次，应恰好 1 次`);
    const secs = lines.filter((l) => /^## \[/.test(l));
    if (secs.length && !/^## \[Unreleased\]/.test(secs[0])) problems.push(`第一个版本节是「${secs[0]}」，Unreleased 必须在最前`);
    if (/[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F]/.test(norm)) problems.push('含不可见控制字节（退格/VT/FF/裸 CR 等）');
    if (problems.length) {
      console.error(`CHANGELOG.md 结构错误：${problems.join('；')}`);
      process.exit(1);
    }
    console.log('  ok   CHANGELOG 结构（# Changelog 开头且唯一 / Unreleased 最前 / 无控制字节）');
  }
}

let bad = 0;
for (const p of targets) {
  const rel = relative(root, p).replace(/\\/g, '/');
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'inherit' });
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
