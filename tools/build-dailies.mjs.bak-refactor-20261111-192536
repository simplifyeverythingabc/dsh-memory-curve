// 生成/刷新每日摘要。由桌面的「刷新记忆笔记」调用，也可单独跑。
// 输出到 ~/.dsh/memory-notes/_摘要/，再由 ps1 同步到 D:\memory\_摘要\
// （node 进程直接写 D 盘会被系统拒 EPERM，所以走两步）
import { buildDailies } from '../profiles/desktop/node_modules/dsh-memory-curve/src/digest.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MEM = process.env.MEMORY_GALAXY_DIR || 'D:\\memory';
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DIG = join(DSH_HOME, 'memory-notes', '_digest');

try {
  const r = buildDailies(MEM, DIG);
  const chars = r.written.reduce((a, x) => a + x.chars, 0);
  console.log(`摘要 ${r.written.length} 天 / 条目 ${r.total} / 事件 ${r.events} / 共 ${chars} 字符`);
  console.log(`输出 ${DIG}`);
} catch (err) {
  console.error('摘要生成失败:', err?.message ?? err);
  process.exitCode = 1;
}