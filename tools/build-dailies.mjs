// 生成/刷新每日摘要。可单独跑，也被「刷新记忆笔记」调用。
//
// 输出固定在 <DSH_HOME>/memory-notes/_digest/ —— 和流水目录分开，流水可以在任何地方。
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 找到 src/ 下的模块。
 *
 * 两种部署形态的目录结构不同，所以两条路径都试：
 *   - 仓库 / 插件包内：tools/ 与 src/ 并列      → ../src/
 *   - 用户脚本目录：~/.dsh/tools/ 隔着 profiles/ → ../profiles/desktop/node_modules/dsh-memory-curve/src/
 *
 * 两边都失败时把两条错误一起打出来 —— 只 catch 不报会把真正的错因（语法错、
 * 依赖缺失）藏成一条无关的 ENOENT。
 */
const SRC_BASES = ['../src/', '../profiles/desktop/node_modules/dsh-memory-curve/src/'];

async function loadSrc(name) {
  const errs = [];
  for (const base of SRC_BASES) {
    try { return await import(base + name); }
    catch (e) { errs.push(`  ${base}${name} → ${e.message}`); }
  }
  console.error(`找不到 src/${name}：`);
  for (const s of errs) console.error(s);
  process.exit(1);
}

const { buildDailies } = await loadSrc('digest.js');
const { resolveMemDir, dshHome } = await loadSrc('paths.js');

// 流水目录与插件、memory-notes.mjs 同一套（src/paths.js）。
const MEM = resolveMemDir();
const DSH_HOME = dshHome();
const DIG = join(DSH_HOME, 'memory-notes', '_digest');

try {
  const r = buildDailies({ memDir: MEM, digestDir: DIG });
  const chars = r.written.reduce((a, x) => a + x.chars, 0);
  console.log(`摘要 ${r.written.length} 天 / 条目 ${r.total} / 事件 ${r.events} / 共 ${chars} 字符`);
  console.log(`流水 ${MEM}`);
  console.log(`输出 ${DIG}`);
} catch (err) {
  console.error('摘要生成失败:', err?.message ?? err);
  process.exitCode = 1;
}
