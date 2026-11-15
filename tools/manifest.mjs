#!/usr/bin/env node
/**
 * 仓库文件的**单一清单**。
 *
 * 为什么要有这个文件：`check.mjs` 有一份「必需文件」列表，`export-code.mjs` 有一份
 * 「导出哪些文件」列表，两处各写一套。0.5.6 加 `setup-dev.mjs` 时只改了前者，于是
 * 《记忆插件完整代码.md》里看不到「怎么造 stub」——而那正是那版想收敛的事。
 *
 * 这是本项目的老病根（「同一件事在多处各写一套」），0.1.x 判过，0.5.6 又复发了一次。
 * 与其加断言盯着两份清单别漂，不如根本只有一份：这里定义，两处消费。
 *
 * 顺序即导出顺序：先配置与文档，再源码，再工具，最后 CI。
 */

/** 配置与说明文档（导出文档的头部） */
export const HEAD_FILES = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
];

/**
 * 源码与脚本 —— **这两个目录下的每个 .js/.mjs 都必须在这里出现**。
 * check.mjs 用它做「必需文件」断言；export-code.mjs 用它决定导出哪些代码。
 */
export const CODE_FILES = [
  'src/index.js',
  'src/events.js',
  'src/digest.js',
  'src/collector.js',
  'src/access.js',
  'src/paths.js',
  'src/embed.js',
  'src/narrate.js',
  'tools/memory-notes.mjs',
  'tools/build-dailies.mjs',
  'tools/manifest.mjs',
  'tools/export-code.mjs',
  'tools/setup-dev.mjs',
  'tools/verify-ids.mjs',
  'tools/collector-test.mjs',
  'tools/collector-host-test.mjs',
  'tools/selftest.mjs',
  'tools/bench.mjs',
  'tools/check.mjs',
];

/** 导出文档的尾部（CI 配置放最后） */
export const TAIL_FILES = [
  '.github/workflows/ci.yml',
];

/** 导出文档包含的全部文件，按顺序 */
export const EXPORT_FILES = [...HEAD_FILES, ...CODE_FILES, ...TAIL_FILES];