import { existsSync } from "node:fs";
import { join } from "node:path";

const sandbox = process.argv[2];
process.env.DSH_MEMORY_DIR = join(sandbox, "memory");
process.env.DSH_HOME = join(sandbox, "dsh-home");

let mod;
try {
  mod = await import("file:///D:/projects/dsh-memory-curve/src/index.js");
} catch (e) {
  console.log("  ✗ 加载失败: " + e.message);
  process.exit(1);
}
console.log("  ✓ 模块加载成功");
console.log("    inject: " + JSON.stringify(mod.inject));
console.log("    apply:  " + typeof mod.apply);

// 模拟宿主：最小 ctx
const tools = {};
let contextText = null;
const ctx = {
  effect(fn) { return fn(); },
  systemPrompt: {
    context(def) {
      contextText = def.text;
      return () => {};
    }
  },
  tools: {
    register(def) { tools[def.name] = def; return () => {}; }
  }
};

try {
  mod.apply(ctx, { maxT1: 12, maxT2: 20, maxT3: 8 });
  console.log("  ✓ apply() 执行成功");
} catch (e) {
  console.log("  ✗ apply() 抛错: " + e.message);
  process.exit(1);
}

console.log("  ✓ 注册工具 " + Object.keys(tools).length + " 个:");
console.log("    " + Object.keys(tools).join(", "));

if (typeof contextText !== "function") {
  console.log("  ✗ context 没注册（或 text 不是函数）");
  process.exit(1);
}

const out = contextText();
const len = String(out).length;
console.log("  ✓ context 注入可求值，输出 " + len + " 字符");
console.log("    首行: " + String(out).split("\n")[0]);

// 调工具
const results = [];
try {
  const r1 = await tools.memory_curve_days.execute();
  results.push("days: " + String(r1.text).split("\n").length + " 行");
} catch (e) { results.push("days: ✗ " + e.message); }

try {
  const r2 = await tools.memory_search.execute({ pattern: "连接池", maxHits: 3 });
  const n = (String(r2.text).match(/m_\d{8}_[0-9a-f]{6}/g) || []).length;
  results.push("search: 命中 " + n + " 条");
} catch (e) { results.push("search: ✗ " + e.message); }

try {
  const r3 = await tools.memory_curve_day.execute({ day: "2026-01-15" });
  results.push("day: " + String(r3.text).split("\n")[0]);
} catch (e) { results.push("day: ✗ " + e.message); }

try {
  const r4 = await tools.memory_curve_build.execute();
  results.push("build: " + String(r4.text).split("\n")[0]);
} catch (e) { results.push("build: ✗ " + e.message); }

console.log("");
console.log("  === 工具实测 ===");
for (const r of results) console.log("    " + r);

const bad = results.filter(r => r.includes("✗"));
if (bad.length) { console.log("\n  ✗ 有 " + bad.length + " 个工具失败"); process.exit(1); }
console.log("\n  ✓ 全部通过 —— 干净环境可以跑");