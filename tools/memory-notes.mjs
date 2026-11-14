import path from 'node:path';

// Same parser, checkpoint and writer as the Host collector. Works from the package or <DSH_HOME>/tools.
const bases = ['../src/', '../profiles/desktop/node_modules/dsh-memory-curve/src/'];
async function load(name) {
  const errors = [];
  for (const base of bases) {
    try { return await import(base + name); }
    catch (e) { errors.push(`${base}${name}: ${e.message}`); }
  }
  throw new Error(errors.join('\n'));
}
try {
  const { dshHome, resolveMemDir } = await load('paths.js');
  const { createCollector } = await load('collector.js');
  const { buildDailies } = await load('digest.js');
  const home = dshHome();
  const out = resolveMemDir();
  const collector = createCollector({
    memDir: out,
    sessionsDir: path.join(home, 'sessions'),
    includeSubagents: process.argv.includes('--include-subagents'),
    onDirty: async (days, memDir) => {
      const r = buildDailies({ memDir, digestDir: path.join(home, 'memory-notes', '_digest'), days });
      console.log(`摘要刷新 ${r.written.length} 天`);
    },
  });
  const result = await collector.run();
  console.log(`采集完成：新增 ${result.added} 条，处理 ${result.scanned} 个日志，待刷新 ${result.pendingDays} 天`);
  console.log(`流水 ${out}`);
} catch (e) {
  console.error(`采集失败（检查点未越过未保存数据）：${e.message}`);
  process.exitCode = 1;
}
