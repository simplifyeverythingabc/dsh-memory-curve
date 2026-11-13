// 生成/刷新每日摘要。可单独跑，也被「刷新记忆笔记」调用。
//
// 输出固定在 <DSH_HOME>/memory-notes/_digest/ —— 和流水目录分开，流水可以在任何地方。
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 找到 digest.js。
 *
 * 两种部署形态的目录结构不同，所以两条路径都试：
 *   - 仓库 / 插件包内：tools/ 与 src/ 并列      → ../src/digest.js
 *   - 用户脚本目录：~/.dsh/tools/ 隔着 profiles/ → ../profiles/desktop/node_modules/dsh-memory-curve/src/digest.js
 */
let buildDailies;
try {
  ({ buildDailies } = await import('../src/digest.js'));
} catch {
  ({ buildDailies } = await import('../profiles/desktop/node_modules/dsh-memory-curve/src/digest.js'));
}

// 流水目录：与插件 src/index.js 的 memDir() 保持同一套优先级。
// DSH_MEMORY_DIR 排第一 —— memory-notes.mjs 也认它，三者必须一致。
const MEM = process.env.DSH_MEMORY_DIR
  || process.env.MEMORY_GALAXY_DIR
  || 'D:\\memory';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
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
