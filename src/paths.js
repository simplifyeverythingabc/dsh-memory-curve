// 记忆目录与 DSH 家目录的唯一真相。插件和三个 tools 都从这里取，别再各写一套。
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
import { join, resolve, isAbsolute } from 'node:path';

/**
 * DSH 家目录。所有环境变量都从参数取，方便测试注入。
 *
 * 以前这里硬读 process.env，而 resolveMemDir(env) 的 env 参数只用于前两条优先级，
 * 最后一行仍然读 process.env.DSH_HOME —— 注入对 DSH_HOME 不生效，是个假的可测性。
 *
 * @param env - 环境变量来源，默认 process.env。
 */
export const dshHome = (env = process.env) =>
  env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');

/**
 * 把用户写的路径规范化：展开 ~、%VAR%、$VAR，统一分隔符，去掉尾斜杠。
 *
 * 从 src/index.js 搬过来 —— Config 的 description 承诺支持这几种写法，
 * 但那只对 config 值生效。用户把同样的写法设进 DSH_MEMORY_DIR 时，
 * 以前会得到一个字面名叫 `%USERPROFILE%\memory` 的目录（Windows 上真会建出来），
 * 然后「插件读到一个空目录」。现在环境变量这条出口也过一遍规范化。
 *
 * @param input - 原始路径字符串。
 * @returns 规范化后的路径；输入为空时返回空串。
 */
export function normalizeDir(input) {
  let s = String(input ?? '').trim();
  if (s === '') return '';
  // %VAR%（Windows）
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? m);
  // $VAR / ${VAR}
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = a || b;
    return process.env[name] ?? m;
  });
  // ~ 开头的家目录
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = join(homedir(), s.slice(1).replace(/^[/\\]/, ''));
  }
  // 统一分隔符、去尾斜杠
  s = s.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  // Windows 盘符写成 D:/memory，转回反斜杠更符合本机习惯
  if (process.platform === 'win32' && /^[A-Za-z]:\//.test(s)) {
    s = s.replace(/\//g, '\\');
  }
  return s;
}

/** resolveMemDir 的短缓存键：这三个变量不变，结果就不会变。 */
let cache = null;

/**
 * 解析完整流水的存放目录。
 *
 * @param env - 环境变量来源，默认 process.env（测试时可注入）。
 * @returns 记忆目录的路径字符串。
 */
export function resolveMemDir(env = process.env) {
  const key = `${env.DSH_MEMORY_DIR || ''}|${env.MEMORY_GALAXY_DIR || ''}|${env.DSH_HOME || ''}`;
  if (cache && cache.key === key) return cache.value;

  const value = (() => {
    const explicit = env.DSH_MEMORY_DIR || env.MEMORY_GALAXY_DIR;
    if (explicit) return normalizeDir(explicit);
    // 只在 Windows 上探 D 盘：POSIX 里 'D:\memory' 是一个合法文件名，
    // 万一 cwd 里真有这个名字，existsSync 会为真，随后 readdirSync 抛 ENOTDIR。
    if (process.platform === 'win32') {
      const legacy = 'D:\\memory';
      try { if (existsSync(legacy)) return legacy; } catch { /* 无权限当没有 */ }
    }
    return join(dshHome(env), 'memory');
  })();

  cache = { key, value };
  return value;
}
