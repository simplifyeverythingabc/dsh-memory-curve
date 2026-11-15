/**
 * 叙事重构（narrative reconstruction，0.13.0）
 *
 * ── 为什么不调 LLM ────────────────────────────────────────────────
 *
 * Bartlett 1932 的「重构记忆」说人回忆不是回放，是按图式重新组装。听起来该用生成模型。
 * 但记忆插件最怕的是**编**：一旦让模型重述，它会在复述里掺进原文没有的因果、情节、
 * 情绪，而你没有便宜的办法分辨哪句是真的。多给一条假记忆，比少给一条糟得多。
 *
 * 所以这里做的是**算法重构**：所有词都取自真实字段（事件标题、实体标签、条数、时间），
 * 只改变**编排**。人回忆时的「重构」本来也不是凭空生成，而是按叙事结构重新串 ——
 * 主线是什么、从哪儿开始、哪件事还悬着、到哪儿收尾。这件事不需要模型。
 *
 * ── 叙事结构 ──────────────────────────────────────────────────────
 *
 * 跟系列位置效应（0.8.0）是同一个道理，只是用在「整天的重述」上：
 *
 *   主线   成员最多、跨度最长的那条主题线 —— 人先想起「那阵子在忙什么」
 *   起点   当天第一个事件（primacy）—— 「怎么开头的」
 *   悬念   openness 最高的未完成项 —— 中间卡在哪
 *   收尾   当天最后一个事件（recency）—— 「最后怎么样了」
 *
 * 四段拼起来是一句话，不是罗列。这是它跟「摘要行」的本质区别。
 */

/**
 * 把一天的 graded 事件重构为一段叙述。
 *
 * @param {Array} graded     gradeEvents 的输出（全部事件）
 * @param {Array} threads    clusterEvents 输出的主题线
 * @param {string} day       YYYY-MM-DD
 * @param {object} [opts]
 * @returns {string} 一段话；当天没有事件时返回空串
 */
export function narrateDay(graded, threads, day, opts = {}) {
  const list = (graded || []).filter((g) => g.day === day);
  if (!list.length) return '';

  const sorted = list.slice().sort((a, b) => a.startAt - b.startAt);

  // 开头/结尾优先用「像人话」的事件：纯路径标题（`@C:\Users\...`、`D:\...`）当开头
  // 或结尾读起来是噪音 —— 实测第一版 11-15 的叙述是「从 @C:\Users\28296\Downloads…
  // 开始，到 check 18/0 收尾」，那个开头等于没说。
  const humanish = sorted.filter((g) => !isPathTitle(g));
  const pool = humanish.length ? humanish : sorted;
  const first = pool[0];
  const last = pool[pool.length - 1];
  const lines = [];

  // ── ① 主线 ──────────────────────────────────────────────────────
  // 当天成员最多的那条线。平手时取跨度更长的（跨度说明它更"成型"）。
  let main = null;
  for (const t of threads || []) {
    const members = (t.members || []).filter((m) => m.day === day);
    if (!members.length) continue;
    if (!main || members.length > main.n || (members.length === main.n && (t.lastAt - t.startAt) > main.span)) {
      main = { t, n: members.length, span: t.lastAt - t.startAt };
    }
  }

  const head = `那天 ${list.length} 件事`;
  if (main && main.n >= 2) {
    lines.push(`${head}，主要在弄「${main.t.label}」`);
  } else {
    lines.push(head);
  }

  // ── ② 起点（primacy）────────────────────────────────────────────
  const title1 = shortTitle(first);
  if (title1 && title1 !== shortTitle(last)) {
    lines.push(`从「${title1}」开始`);
  }

  // ── ③ 悬念（蔡加尼克）──────────────────────────────────────────
  // openness 最高、且不在首尾的那一条 —— 中间悬着的事才是"那天卡在哪"。
  const open = sorted
    .filter((g) => g !== first && g !== last && (g.openness || 0) >= 0.3)
    .sort((a, b) => (b.openness || 0) - (a.openness || 0))[0];
  if (open) {
    const t = shortTitle(open);
    if (t) lines.push(`中间「${t}」还悬着`);
  }

  // ── ④ 收尾（recency）────────────────────────────────────────────
  const titleN = shortTitle(last);
  if (titleN) lines.push(`到「${titleN}」收尾`);

  // 全篇不超过 4 句 —— 超了就不是"一句回忆"，是流水账
  const maxSentences = typeof opts.maxSentences === 'number' ? opts.maxSentences : 4;
  const kept = lines.slice(0, maxSentences);
  return kept.join('，') + '。';
}

/**
 * 标题是不是「纯路径」——`@C:\Users\...`、`D:\memory`、`/home/x/y` 这类。
 * 这种标题在叙述里没有信息量（它只说明"那天有人发了个文件"），选开头/结尾时要避开。
 */
function isPathTitle(g) {
  const t = String((g && (g.head || g.title)) || '');
  return /^[@\s]*([A-Za-z]:[\\/]|\/[\w.-]+\/)/.test(t) || /\.(md|js|mjs|json|tgz|zip|png|jpg)$/i.test(t);
}
/**
 * 取事件的一句话标题：优先用已经算好的 head，退化到首条文本的第一句。
 * 截断到 26 字 —— 重述要短，细节留给原文。
 */
function shortTitle(g) {
  const raw = String((g && (g.head || g.title)) || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const cut = raw.length > 26 ? raw.slice(0, 25) + '…' : raw;
  return cut.replace(/^[-—\s]+/, '');
}

/**
 * 把多天的重构串起来（给报告用）。只保留有事件的天。
 */
export function narrateRange(graded, threads, days, opts = {}) {
  const out = [];
  for (const d of days || []) {
    const s = narrateDay(graded, threads, d, opts);
    if (s) out.push(`- ${d}　${s}`);
  }
  return out.join('\n');
}
