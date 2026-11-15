#!/usr/bin/env node
/**
 * 在干净 checkout 里补齐本地测试需要的东西。
 *
 * 为什么要有：`src/index.js` 静态 import `@deepseek-ai/schemastery`，这个包只有 DSH 宿主
 * 里才有，仓库本身没有依赖。于是每次环境重建（清 node_modules、换机器、CI）都要手工
 * 再造一遍 stub —— 和 `.github/workflows/ci.yml` 里那段一模一样的内容，两处维护。
 *
 * 现在收敛到这一处：本地跑 `npm run setup`，CI 也可以直接调这个脚本，不再各写一份。
 *
 * 它只造一个**最小 stub**，够让 selftest 检验「接口形状对不对」，不是真实现：
 *   z.object/z.string/z.number/z.boolean
 *   以及 default/description/volatile/min/max 的链式调用
 *
 * 幂等：已经存在且内容一致就跳过；内容不一致会覆盖（stub 没有本地改动价值）。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery');

const PKG = `{
  "name": "@deepseek-ai/schemastery",
  "version": "0.0.0",
  "type": "module",
  "main": "index.js"
}
`;

const INDEX = `const mk = (type, meta = {}) => {
  const fn = (v) => (v === undefined ? meta.default : v);
  fn.type = type;
  fn.meta = meta;
  fn.dict = undefined;
  fn.default = (d) => mk(type, { ...meta, default: d });
  fn.description = (s) => mk(type, { ...meta, description: s });
  fn.volatile = () => mk(type, { ...meta, volatile: true });
  fn.min = (n) => mk(type, { ...meta, min: n });
  fn.max = (n) => mk(type, { ...meta, max: n });
  fn.toJSON = () => ({ type, meta });
  return fn;
};
const z = {
  string: () => mk('string'),
  number: () => mk('number'),
  boolean: () => mk('boolean'),
  object: (dict) => {
    const fn = (v) => v;
    fn.type = 'object';
    fn.meta = { default: {} };
    fn.dict = dict;
    fn.toJSON = () => ({ type: 'object', meta: fn.meta, dict });
    return fn;
  },
};
export default z;
`;

function put(file, content) {
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (cur === content) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return true;
}

const a = put(join(DIR, 'package.json'), PKG);
const b = put(join(DIR, 'index.js'), INDEX);

if (a || b) console.log(`已写入 schemastery stub：${DIR}`);
else console.log(`schemastery stub 已是最新：${DIR}`);

// 顺手确认关键依赖都在，缺了就说清楚缺什么，而不是等到 selftest 抛一句报错
const need = ['@deepseek-ai/schemastery'];
const miss = need.filter((n) => !existsSync(join(ROOT, 'node_modules', ...n.split('/'))));
if (miss.length) {
  console.error(`缺少：${miss.join('、')}`);
  process.exitCode = 1;
}