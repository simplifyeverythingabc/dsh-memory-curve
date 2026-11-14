import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { setImmediate as yieldLoop } from 'node:timers/promises';

const BEGIN = '<!-- dsh-note:auto-begin:7f3a -->';
const END = '<!-- dsh-note:auto-end:7f3a -->';
const HEAD = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) ［([^\n]+?)］(?:\s*<!--\s*(m_\d{8}_[0-9a-f]{6})\s*-->)?\s*$/gm;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const emptyState = () => ({ version: 1, files: {}, done: {}, dirtyDays: [], lastSuccess: null, lastError: null });
const splitList = (s) => Array.isArray(s) ? s : String(s || '').split(/[\r\n;]+/).map(s => s.trim()).filter(Boolean);

/** File and checkpoint writers share atomic replacement; a failed rename keeps the old file. */
export async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tmp, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
  } finally {
    if (handle) await handle.close();
    await fs.rm(tmp, { force: true });
  }
}

async function textOrEmpty(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

export function sessionAllowed(header = {}, options = {}) {
  if (!options.includeSubagents && (header.origin === 'subagent' || header.parentSession || header.delegationDepth > 0)) return false;
  if (splitList(options.excludeSessions).includes(header.id)) return false;
  const canonical = (p) => {
    const s = path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  if (header.cwd) {
    const cwd = canonical(header.cwd);
    if (splitList(options.excludeCwds).some(p => cwd === canonical(p) || cwd.startsWith(canonical(p) + '/'))) return false;
  }
  return true;
}

/** Read only real message records. Neither stream deltas nor compaction replacements are messages to collect. */
export function messageFromEvent(event, header = {}, options = {}) {
  if (!sessionAllowed(header, options)) return null;
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return null;
  if (event.surfaceOp && event.surfaceOp !== 'append') return null;
  if (event.sourceEventSeqs?.length || event.data?.interrupted) return null;
  const msg = event.data?.message ?? event.data;
  const role = event.type === 'user/message' ? 'user' : 'assistant';
  if (!msg || msg.role !== role) return null;
  const kind = msg.source?.kind;
  if (kind && kind !== (role === 'user' ? 'user' : 'model')) return null;
  let text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content)
    ? msg.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
  // Legacy messages sometimes embed reasoning in text; typed reasoning blocks were excluded above.
  text = text.replace(/<(thinking|thought|think|analysis)\b[^>]*>[\s\S]*?<\/\1>/gi, '').trim();
  if (!text) return null;
  const time = Number(event.time ?? msg.time);
  const seq = Number(event.seq);
  if (!Number.isFinite(time) || !Number.isSafeInteger(seq) || seq < 0 || !Number.isFinite(new Date(time).getTime())) return null;
  const sessionId = String(header.id || '');
  if (!sessionId) return null;
  return { sessionId, seq, time, role, text };
}

// Parse the actual Zstandard frame length. Searching for magic inside compressed payload can silently cut valid frames.
export function zstdFrameLength(buf) {
  if (buf.length < 4) return null;
  const magic = buf.readUInt32LE(0);
  if ((magic >>> 4) === (0x184d2a50 >>> 4)) {
    if (buf.length < 8) return null;
    const length = 8 + buf.readUInt32LE(4);
    return buf.length >= length ? { length, skip: true } : null;
  }
  if (magic !== 0xfd2fb528) throw new Error('Invalid zstd frame magic; checkpoint left unchanged');
  if (buf.length < 5) return null;
  const fhd = buf[4];
  if (fhd & 8) throw new Error('Reserved zstd frame header bit');
  const single = Boolean(fhd & 32);
  const flag = fhd >>> 6;
  let pos = 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + (flag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][flag]);
  if (buf.length < pos) return null;
  for (;;) {
    if (buf.length < pos + 3) return null;
    const block = buf.readUIntLE(pos, 3);
    pos += 3;
    const type = (block >>> 1) & 3;
    if (type === 3) throw new Error('Reserved zstd block type');
    pos += type === 1 ? 1 : block >>> 3;
    if (buf.length < pos) return null;
    if (block & 1) break;
  }
  if (fhd & 4) pos += 4;
  return buf.length >= pos ? { length: pos, skip: false } : null;
}

async function* frames(file, offset, size) {
  const handle = await fs.open(file, 'r');
  let buffer = Buffer.alloc(0), position = offset, end = offset;
  try {
    while (position < size || buffer.length) {
      const frame = zstdFrameLength(buffer);
      if (frame) {
        end += frame.length;
        const raw = buffer.subarray(0, frame.length);
        buffer = buffer.subarray(frame.length);
        yield { end, bytes: frame.skip ? Buffer.alloc(0) : zstdDecompressSync(raw) };
        continue;
      }
      if (position >= size) break; // Incomplete trailing frame: retry the same bytes on next pass.
      const chunk = Buffer.alloc(Math.min(256 * 1024, size - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
    }
  } finally { await handle.close(); }
}

async function* logFiles(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* logFiles(full);
    else if (entry.isFile() && entry.name === 'session.v4.jsonl.zstd') yield full;
  }
}

async function withLock(memDir, fn) {
  const dir = path.join(memDir, '.memory-collector');
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, 'write.lock');
  const owner = path.join(lock, 'owner.json');
  const token = randomUUID();
  try { await fs.mkdir(lock); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let alive = true;
    try {
      const p = JSON.parse(await fs.readFile(owner, 'utf8')).pid;
      if (!Number.isInteger(p) || p <= 0) throw new Error('Invalid lock owner');
      try { process.kill(p, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
    } catch (err) {
      // owner.json 读到一半、磁盘满、内容被写坏 —— 这些 err.code 都不是 ENOENT，
      // 以前只处理 ENOENT，alive 保持 true，于是永久 ELOCKED：谁也别想再写。
      // 读不出可信 owner 就按「锁可能已死」处理，靠 mtime 兜底判断。
      if (err.code === 'ENOENT' || err.code === undefined || err.code === 'EACCES') {
        alive = Date.now() - (await fs.stat(lock)).mtimeMs < 60000;
      }
    }
    if (alive) throw Object.assign(new Error('Another memory collector holds the write lock; retry later'), { code: 'ELOCKED' });
    // Rename before removal: only one contender can adopt a dead lock.
    const stale = `${lock}.stale-${token}`;
    await fs.rename(lock, stale);
    await fs.rm(stale, { recursive: true });
    await fs.mkdir(lock);
  }
  try {
    await fs.writeFile(owner, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
    return await fn(dir);
  } finally {
    const value = await textOrEmpty(owner);
    let ownerToken = null;
    try { ownerToken = value ? JSON.parse(value).token : null; } catch { /* 损坏的 owner 按不匹配处理，保留原始错误 */ }
    if (ownerToken === token) await fs.rm(lock, { recursive: true });
  }
}

/**
 * 把一段文本切成「记忆条目」块。
 *
 * 同时回传第一个 HEAD 之前的原文（orphans）。AUTO 区里常有人手写的批注、
 * 分隔线或说明，它们不是条目；以前只 map 出 hits，那段文本在重写时直接蒸发，
 * 属于静默丢数据。两头的处理不一样：
 *   · 首个 HEAD 之前  → 完整保留（orphans）
 *   · 两个 HEAD 之间  → 无法与上一条正文区分，仍随上一条走（已知局限，写在 README）
 */
function blocksIn(text) {
  const hits = [...text.matchAll(HEAD)];
  const orphans = (hits.length ? text.slice(0, hits[0].index) : text).trim();
  const blocks = hits.map((h, i) => {
    const raw = text.slice(h.index, hits[i + 1]?.index ?? text.length).trimEnd();
    return { raw, id: h[4], who: h[3], time: `${h[1]} ${h[2]}`,
      text: raw.slice(h[0].length).replace(/<!-- memory-source:[0-9a-f]{64} -->\s*/g, '').trim(),
      source: raw.match(/<!-- memory-source:([0-9a-f]{64}) -->/)?.[1] };
  });
  return { blocks, orphans };
}

async function mergeDay(memDir, day, messages) {
  const file = path.join(memDir, `${day}.md`);
  const old = await textOrEmpty(file);
  const begin = old.indexOf(BEGIN), end = old.indexOf(END);
  if ((begin >= 0) !== (end >= 0) || (begin >= 0 && (end < begin || old.indexOf(BEGIN, begin + BEGIN.length) >= 0 || old.indexOf(END, end + END.length) >= 0))) {
    throw new Error(`Malformed AUTO region in ${file}; existing content left unchanged`);
  }
  const body = begin >= 0 ? old.slice(begin + BEGIN.length, end) : '';
  const outside = begin >= 0 ? old.slice(0, begin) + old.slice(end + END.length) : old;
  const { blocks, orphans: rawOrphans } = blocksIn(body);
  // 首个 HEAD 之前的内容里，第一行是我们自己写进去的日期标题（nextBody 的 `${day}`）。
  // 不剥掉它会当成批注原样保留，下次合并又被收一次 —— 每采一批就多一行日期。
  // 真正的批注是「日期行之后」的部分，那些必须留。
  const orphans = rawOrphans.replace(/^(?:[ \t]*\d{4}-\d{2}-\d{2}[ \t]*\r?\n?)+/, '').trim();
  const outsideParsed = blocksIn(outside);
  const all = [...blocks, ...outsideParsed.blocks];
  const ids = new Map(all.filter(b => b.id).map(b => [b.id, b]));
  const sources = new Set(all.map(b => b.source).filter(Boolean));
  const roleMatches = (who, role) => role === 'user' ? ['主人', '用户', 'user'].includes(who) : ['小鱼', '助手', 'assistant'].includes(who);
  let added = 0;
  for (const m of messages) {
    const source = sha(`${m.sessionId}\0${m.seq}`);
    if (sources.has(source)) continue;
    const safe = m.text.split(/\r?\n/).map(line => line.replace(/<!--\s*(dsh-note:auto-(?:begin|end):7f3a|memory-source:)/g, '&lt;!-- $1')).join('\n');
    const legacyId = `m_${day.replace(/-/g, '')}_${createHash('sha1').update(m.text).digest('hex').slice(0, 6)}`;
    const legacy = ids.get(legacyId);
    // Upgrade without renaming existing anchors. Only legacy content-addressed records are adopted.
    if (legacy && !legacy.source && roleMatches(legacy.who, m.role) && legacy.text === safe) continue;
    let salt = 0, id;
    do { id = `m_${day.replace(/-/g, '')}_${sha(`${source}\0${m.role}\0${m.text}\0${salt++}`).slice(0, 6)}`; } while (ids.has(id));
    const at = new Date(m.time);
    const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const who = m.role === 'user' ? '用户' : '助手';
    const raw = `${day} ${hhmm} ［${who}］ <!-- ${id} -->\n<!-- memory-source:${source} -->\n${safe}`;
    const block = { raw, id, who, time: `${day} ${hhmm}`, source, text: safe };
    blocks.push(block); ids.set(id, block); sources.add(source); added++;
  }
  if (!added) return 0;
  blocks.sort((a, b) => a.time.localeCompare(b.time));
  // orphans 必须回到 AUTO 区开头：那是人手写的批注或分隔线，不属于任何条目，
  // 但以前会被整段吃掉。放在所有条目之前，和它的原位置一致。
  const nextBody = `\n${day}\n\n${orphans ? `${orphans}\n\n` : ''}${blocks.map(b => b.raw).join('\n\n')}\n`;
  // Keep the manual prefix and suffix byte-for-byte, including line breaks.
  const next = begin >= 0 ? old.slice(0, begin + BEGIN.length) + nextBody + old.slice(end)
    : old + (old && !old.endsWith('\n') ? '\n' : '') + `${BEGIN}${nextBody}${END}\n`;
  await writeAtomic(file, next);
  return added;
}

/** One ordered writer, shared by the live adapter and CLI. Output directory owns its own checkpoint and lock. */
export function createCollector({ memDir, sessionsDir, includeSubagents = false, excludeCwds = '', excludeSessions = '', onDirty = async () => {}, fault = async () => {} }) {
  let chain = Promise.resolve();
  const options = { includeSubagents, excludeCwds, excludeSessions };
  const status = { running: false, lastSuccess: null, lastError: null, added: 0, pendingDays: 0 };
  const getDir = () => path.resolve(typeof memDir === 'function' ? memDir() : memDir);
  const serial = (fn) => {
    const run = chain.catch(() => {}).then(fn);
    chain = run;
    return run;
  };
  async function pass(live, scan, refresh) {
    status.running = true;
    try {
      const outputDir = getDir(); // A volatile Config change takes effect on the next pass, never halfway through a commit.
      return await withLock(outputDir, async (dir) => {
        const stateFile = path.join(dir, 'state.json');
        const raw = await textOrEmpty(stateFile);
        const state = raw ? JSON.parse(raw) : emptyState();
        if (state.version !== 1 || !state.files || !state.done || !Array.isArray(state.dirtyDays)) throw new Error('Invalid collector checkpoint; preserved for inspection');
        const save = () => writeAtomic(stateFile, JSON.stringify(state));
        let added = 0, scanned = 0;
        async function commit(messages, finish) {
          const days = [...new Set(messages.map(m => dayOf(m.time)))];
          // Dirty intent precedes data; checkpoint follows data. Crash replay is source-idempotent.
          state.dirtyDays = [...new Set([...state.dirtyDays, ...days])];
          await save();
          for (const day of days) added += await mergeDay(outputDir, day, messages.filter(m => dayOf(m.time) === day));
          await fault('after-data');
          finish();
          state.lastSuccess = new Date().toISOString(); state.lastError = null;
          await save();
        }
        if (scan) {
          for await (const file of logFiles(sessionsDir)) {
            const st = await fs.stat(file);
            const handle = await fs.open(file, 'r');
            const prefix = Buffer.alloc(Math.min(64, st.size));
            try { await handle.read(prefix, 0, prefix.length, 0); } finally { await handle.close(); }
            const identity = sha(prefix);
            const prev = state.files[file];
            const cp = prev && prev.identity === identity && prev.offset <= st.size && prev.dev === st.dev && prev.ino === st.ino
              ? { ...prev } : { offset: 0, lineNo: 0, header: null, seeded: false, identity, dev: st.dev, ino: st.ino };
            if (cp.offset === st.size && cp.size === st.size && cp.mtime === st.mtimeMs) continue;
            let pending = Buffer.alloc(0), safe = { ...cp }, messages = [], done = { ...state.done }, count = 0;
            for await (const frame of frames(file, cp.offset, st.size)) {
              pending = Buffer.concat([pending, frame.bytes]);
              const last = pending.lastIndexOf(10);
              if (last >= 0) {
                const complete = pending.subarray(0, last + 1).toString('utf8');
                pending = pending.subarray(last + 1);
                for (const line of complete.split('\n')) {
                  if (!line.trim()) continue;
                  const event = JSON.parse(line); // A malformed event stops here: never silently advance past it.
                  cp.lineNo++;
                  if (event.type === 'session') { cp.header = event; cp.seeded = Boolean(event.isSeeded); continue; }
                  if (event.type === 'session/end-seed') { cp.seeded = false; continue; }
                  if (!cp.header || cp.seeded) continue;
                  const seq = Number.isSafeInteger(event.seq) ? event.seq : cp.lineNo;
                  const sid = cp.header.id;
                  // Scan uses only byte cursors, not live high-water marks: disk backlog may predate a live event.
                  const msg = messageFromEvent({ ...event, seq }, cp.header, options);
                  if (msg) messages.push(msg);
                  if (sessionAllowed(cp.header, options)) done[sid] = Math.max(done[sid] ?? -1, seq);
                }
              }
              if (!pending.length) {
                cp.offset = frame.end;
                safe = { ...cp };
              }
              if (++count % 64 === 0) await yieldLoop();
            }
            // An unterminated JSON line leaves the cursor at the prior complete frame. Replay deduplicates records.
            if (safe.offset !== (prev?.offset ?? 0) || !prev) {
              await commit(messages, () => {
                state.files[file] = { ...safe, size: st.size, mtime: st.mtimeMs };
                state.done = done;
              });
              scanned++;
            }
          }
        }
        if (live.length) {
          const done = { ...state.done };
          const messages = [];
          for (const { header, event } of live.sort((a, b) => a.event.seq - b.event.seq)) {
            if (!sessionAllowed(header, options)) continue;
            if (!Number.isSafeInteger(event.seq) || event.seq <= (done[header.id] ?? -1)) continue;
            const msg = messageFromEvent(event, header, options);
            if (msg) messages.push(msg);
            done[header.id] = event.seq;
          }
          if (messages.length || JSON.stringify(done) !== JSON.stringify(state.done)) await commit(messages, () => { state.done = done; });
        }
        if (refresh && state.dirtyDays.length) {
          await onDirty([...state.dirtyDays], outputDir);
          await fault('after-summary');
          state.dirtyDays = [];
          await save();
        }
        status.added += added; status.pendingDays = state.dirtyDays.length;
        status.lastSuccess = state.lastSuccess; status.lastError = null;
        return { added, scanned, pendingDays: state.dirtyDays.length };
      });
    } catch (e) { status.lastError = String(e.message || e); throw e; }
    finally { status.running = false; }
  }
  return { status,
    run: ({ live = [], scan = true, refresh = true } = {}) => serial(() => pass(live, scan, refresh)),
  };
}

/** Host event callbacks only enqueue. Timers and listeners are owned by the plugin effect. */
export function mountAutoCollector(ctx, { flushMs = 1500, scanMs = 60000, summaryMs = 5000, onError = console.warn, ...options }) {
  const collector = createCollector(options);
  let queue = [], timer = null, interval = null, closed = false, busy = false, scanPending = true;
  let summaryAt = 0;
  let backoff = flushMs;
  const schedule = (delayMs = flushMs) => {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = null; void drain(); }, delayMs);
    timer.unref?.();
  };
  async function drain() {
    if (closed || busy) return;
    busy = true;
    const batch = queue; queue = [];
    const scan = scanPending; scanPending = false;
    const refresh = Date.now() - summaryAt >= summaryMs;
    try {
      await collector.run({ live: batch, scan, refresh });
      backoff = flushMs;
      if (refresh) summaryAt = Date.now();
    } catch (e) {
      queue = [...batch, ...queue]; scanPending ||= scan;
      backoff = Math.min(Math.max(flushMs, backoff * 2), 30000);
      onError(`[memory-curve] 自动采集失败，保留队列待重试（${backoff}ms）：${e.message}`);
    }
    finally {
      busy = false;
      if (queue.length || scanPending || collector.status.pendingDays || collector.status.lastError) schedule(backoff);
    }
  }
  const remove = ctx.on('session/event', (session, event) => {
    if (closed || (event.type !== 'user/message' && event.type !== 'assistant/message')) return;
    if (session.header?.isSeeded) return;
    if (typeof session.isOwnSeq === 'function' && !session.isOwnSeq(event.seq)) return;
    queue.push({ header: { ...session.header, id: session.id }, event });
    schedule();
  });
  interval = setInterval(() => { scanPending = true; schedule(); }, scanMs);
  interval.unref?.();
  schedule(); // catch up cold sessions as well as messages committed before registration
  return {
    collector,
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      // Wait for an in-flight pass before taking the final snapshot.
      while (busy) await yieldLoop();
      const batch = queue; queue = [];
      try { return await collector.run({ live: batch, scan: true, refresh: true }); }
      catch (e) { queue = [...batch, ...queue]; throw e; }
    },
    dispose() {
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      if (typeof remove === 'function') remove();
      // Host teardown may not await effects. Unwritten events are replayed from the session log on next startup.
    },
  };
}
