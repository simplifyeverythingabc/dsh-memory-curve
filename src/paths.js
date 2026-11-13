// 记忆目录的唯一真相。插件和三个 tools 都从这里取，别再各写一套。
//
// 优先级（四处必须一致）：
//   1. DSH_MEMORY_DIR
//   2. MEMORY_GALAXY_DIR（兼容旧的 dsh-memory-galaxy）
//   3. D:\memory        —— Windows 老用户的历史位置，存在才用
//   4. <DSH_HOME>/memory —— 跨平台默认
//
// 为什么读侧也要认 D:\memory：老用户的 1700+ 条流水在那儿，不认等于装完是空索引。
// 为什么写侧（tools/memory-notes.mjs）不能静默改写别处：某些环境 node 写非系统盘会
// EPERM，那一步由 assertWritable() 显式报错，不做静默回退 —— 静默回退就是「写一个
// 读另一个」的来源。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');

/**
 * 解析完整流水的存放目录。
 *
 * @param env - 环境变量来源，默认 process.env（测试时可注入）。
 * @returns 记忆目录的绝对或相对路径字符串。
 */
export function resolveMemDir(env = process.env) {
  const explicit = env.DSH_MEMORY_DIR || env.MEMORY_GALAXY_DIR;
  if (explicit) return explicit;
  const legacy = 'D:\\memory';
  try { if (existsSync(legacy)) return legacy; } catch { /* 无权限当没有 */ }
  return join(dshHome(), 'memory');
}
