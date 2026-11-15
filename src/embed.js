/**
 * 语义向量（embedding，0.12.0）
 *
 * 为什么要这一层：0.3.9 → 0.11.0 的所有「相似」判断都是**字符级**的 ——
 * 二元切词后的 Jaccard、标识符指纹的集合交集。它们能分开「插件调试」和「QQ 闲聊」，
 * 但分不开「排查连接池超时」和「连接池 maxWait 超时了」—— 同一个意思，用词不同。
 *
 * bge-small-zh-v1.5 把这个解决掉：中文专用、24M 参数、512 维。实测
 *   近义「排查连接池超时」vs「连接池 maxWait 超时了」  余弦 0.8423
 *   无关 vs「今天午饭吃了碗面」                        余弦 0.2887
 * 区分度 0.55，非常干净。编码 2 ms/条（CPU，WASM）。
 *
 * ── 三条设计约束 ──────────────────────────────────────────────────
 *
 * 1. **不阻塞启动**。模型首次要下 ~100 MB（测下来 33.8 秒），之后本地加载几秒。
 *    `apply()` 是同步的，所以这里把加载放到后台，加载完才能用 —— 加载期间
 *    `status !== 'ready'`，调用方自动退回字符匹配。
 *
 * 2. **模型不可用必须静默降级**。没装依赖、没网、镜像也挂，都不能让插件崩。
 *    `init()` 失败只记状态，不抛。
 *
 * 3. **向量落盘**。每次重启重算 160 条是 320 ms，不算慢，但语料长到几千条就是秒级。
 *    缓存用 base64 存 Float32Array（512 维 = 2731 字符/条），比 JSON 数组小 3 倍也快 3 倍。
 *
 * ── 关于镜像 ───────────────────────────────────────────────────────
 * huggingface.co 在这台机器上 SSL 不通，hf-mirror.com 通。所以默认走镜像，
 * 但允许调用方覆盖（别人可能在墙外，或者有企业代理）。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const EMBED_MODEL = 'Xenova/bge-small-zh-v1.5';
export const EMBED_DIM = 512;
export const EMBED_MIRROR = 'https://hf-mirror.com';

/** 单条文本送进模型的截断长度（字符）。bge 的上下文是 512 token，中文约 1 字 1 token。 */
const MAX_CHARS = 200;

/**
 * @param {object} opts
 * @param {string} opts.cacheFile 向量缓存文件（_vectors.json）
 * @param {string} opts.modelDir  模型权重目录
 * @param {string} [opts.mirror]  下载镜像
 * @returns 一个惰性初始化的 embedder
 */
export function createEmbedder({ cacheFile, modelDir, mirror = EMBED_MIRROR }) {
  let pipe = null;
  let status = 'idle';          // idle | loading | ready | failed
  let err = null;
  const vec = new Map();        // key -> Float32Array(512)
  let dirty = false;

  function load() {
    try {
      const o = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (!o || o.model !== EMBED_MODEL || !o.vec) return;
      for (const [k, b64] of Object.entries(o.vec)) {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length !== EMBED_DIM * 4) continue;      // 维度不对的旧缓存直接丢
        vec.set(k, new Float32Array(buf.buffer, buf.byteOffset, EMBED_DIM));
      }
    } catch {
      // 读不到 / 坏文件：当空缓存，下次重新编码。绝不因为缓存坏了让插件挂掉。
    }
  }

  function save() {
    if (!dirty) return;
    try {
      const out = {};
      for (const [k, v] of vec) {
        out[k] = Buffer.from(v.buffer, v.byteOffset, EMBED_DIM * 4).toString('base64');
      }
      mkdirSync(dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ _v: 1, model: EMBED_MODEL, vec: out }), 'utf8');
      renameSync(tmp, cacheFile);                        // 原子写，同 _threads.json
      dirty = false;
    } catch {
      // 写不进去只是下次重算，不影响本次
    }
  }

  /** 后台加载模型。失败只记状态，不抛。 */
  async function init() {
    if (status !== 'idle') return status;
    status = 'loading';
    try {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = modelDir;
      env.remoteHost = mirror;
      env.allowRemoteModels = true;
      pipe = await pipeline('feature-extraction', EMBED_MODEL);
      status = 'ready';
    } catch (e) {
      err = String((e && e.message) || e).slice(0, 240);
      status = 'failed';
    }
    return status;
  }

  /**
   * 惰性编码：只编还没有向量的条目。
   *
   * @param {Array<{key: string, text: string}>} items
   * @returns {Promise<number>} 本次新编码了多少条
   */
  async function encode(items) {
    if (status !== 'ready' || !pipe) return 0;
    const need = [];
    const seen = new Set();
    for (const it of items || []) {
      if (!it || !it.key || !it.text) continue;
      if (vec.has(it.key) || seen.has(it.key)) continue;
      seen.add(it.key);
      need.push(it);
    }
    if (!need.length) return 0;
    for (const it of need) {
      try {
        const r = await pipe(String(it.text).slice(0, MAX_CHARS), { pooling: 'mean', normalize: true });
        if (r && r.data && r.data.length === EMBED_DIM) {
          vec.set(it.key, new Float32Array(r.data));
        }
      } catch {
        // 单条编码失败就跳过它，其余继续 —— 一条坏数据不该让整批失败
      }
    }
    dirty = true;
    return need.length;
  }

  /** 余弦相似度（向量已归一化，点积即是）。缺任一端返回 null，调用方据此回退。 */
  function sim(a, b) {
    const x = vec.get(a);
    const y = vec.get(b);
    if (!x || !y) return null;
    let s = 0;
    for (let i = 0; i < EMBED_DIM; i++) s += x[i] * y[i];
    return s;
  }

  return {
    init,
    encode,
    sim,
    load,
    save,
    /** 清空（测试用） */
    clear() { vec.clear(); dirty = true; status = 'idle'; pipe = null; err = null; },
    get status() { return status; },
    get error() { return err; },
    get size() { return vec.size; },
    has(key) { return vec.has(key); },
  };
}
