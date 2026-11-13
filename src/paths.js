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
 * @param env - 环境变量来源，默认 process.env。
 */
export const dshHome = (env = process.env) =>
  env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');

/**
 * 把用户写的路径规范化：展开 ~、%VAR%、$VAR，统一分隔符，去尾斜杠，相对转绝对。
 *
 * 五个坑都在这一个函数里，改动时注意：
 *
 *   1. 变量展开和 ~ 用传入的 env，不是 process.env —— 否则 dshHome(env) 可注入、
 *      这里不可注入，测试里展开的还是真实值，是假的可测性。
 *   2. UNC 必须在压分隔符之前记下来：'\\server\share' 压完是 '/server/share'，
 *      再判断就晚了 —— Windows 会把开头的 /server 当成当前盘的 \server。
 *   3. 去尾斜杠要放过三种根：'/'（POSIX 根）、'//'（UNC 头）、'C:/'（盘符根）。
 *      注意这时盘符根已经是 'C:/'，模式得带斜杠 —— 写 /^[A-Za-z]:$/ 永远匹配不到，
 *      结果被削成 'C:'（Windows 上表示「C 盘当前目录」，不是根）。
 *   4. 相对路径必须转绝对。搬进这个文件时漏过一次，后果是同一个 'memory'
 *      被插件和 tools 解析成两个不同目录 —— 正是这个文件要消灭的问题。
 *
 * @param input - 原始路径字符串。
 * @param env - 环境变量来源，默认 process.env。
 * @returns 规范化后的路径；输入为空时返回空串。
 */
export function normalizeDir(input, env = process.env) {
  let s = String(input ?? '').trim();
  if (s === '') return '';

  // 1) 变量展开（Windows 的 %VAR%，Unix 的 $VAR / ${VAR}）
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => env[name] ?? m);
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, a, b) => env[a || b] ?? m);

  // 2) ~ 开头的家目录，同样走 env
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = join(env.USERPROFILE || env.HOME || homedir(), s.slice(1).replace(/^[/\\]/, ''));
  }

  // 3) UNC 先记标记，再统一分隔符
  const unc = /^\\\\/.test(s);
  s = s.replace(/[\\/]+/g, '/');
  if (unc) s = '//' + s.replace(/^\/+/, '');

  // 4) 去尾斜杠，放过三种根
  if (s !== '/' && s !== '//' && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, '');

  // 5) 盘符路径转回反斜杠（本机习惯）：'C:/memory' → 'C:\memory'
  if (process.platform === 'win32' && /^[A-Za-z]:\//.test(s)) s = s.replace(/\//g, '\\');

  // 6) 相对路径转绝对 —— 漏了这一步，'memory' 会在两个进程里指向两个目录
  if (!isAbsolute(s)) s = resolve(s);

  return s;
}

/** resolveMemDir 的短缓存：这五个变量不变，结果就不会变。 */
let cache = null;

/**
 * 解析完整流水的存放目录。
 *
 * @param env - 环境变量来源，默认 process.env（测试时可注入）。
 * @returns 记忆目录的路径字符串。
 */
export function resolveMemDir(env = process.env) {
  // USERPROFILE / HOME 也要进 key：dshHome(env) 在家目录上做兜底，
  // 只覆盖前三个的话，换一个 USERPROFILE 仍然命中旧缓存。
  const key = [env.DSH_MEMORY_DIR, env.MEMORY_GALAXY_DIR, env.DSH_HOME, env.USERPROFILE, env.HOME]
    .map((x) => x || '').join('|');
  if (cache && cache.key === key) return cache.value;

  const value = (() => {
    const explicit = env.DSH_MEMORY_DIR || env.MEMORY_GALAXY_DIR;
    if (explicit) return normalizeDir(explicit, env);
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
