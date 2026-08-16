/**
 * 检索评分：把「查询串 × 目录条目 / 文档片段」映射为一个 0..1 的相关度分数。
 *
 * 设计原则：
 *  - 分数由「信号」构成（名称精确/前缀/别名/摘要命中），每个信号附带权重；
 *  - 名称类命中权重最高，摘要命中次之，流行度仅作平局微调（对数缩放，避免大库碾压小库）；
 *  - 返回 matches 信号列表，供输出层向模型解释"为什么排前面"，增加可核查性。
 */

/** 分词：小写、按非字母数字切分；CJK 逐字成词（中文无空格，需单字索引） */
export function tokenize(text) {
  const normalized = String(text ?? '').toLowerCase()
  const tokens = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? []
  return tokens
}

function tokenSet(text) {
  return new Set(tokenize(text))
}

/**
 * 流行度微调：只在当前信号层级的余量内加分（raw + (1-raw)*boost），
 * 保证「精确匹配 > 别名 > 前缀 > 词元重叠」的层级顺序永不被流行度反转；
 * 1000 流行度 → boost 0.03，对数缩放且封顶 0.1；
 * 流行度 < 1（含归一化 0..1 比例表）不微调，避免负对数压分。
 */
function popularityBoost(popularity) {
  const p = Number(popularity)
  if (!Number.isFinite(p) || p < 1) return 0
  return Math.min(0.1, Math.log10(p) / 100)
}

/**
 * 对目录条目评分。
 * @param {string} query 用户查询
 * @param {object} entry 条目：{ id, name, summary?, aliases?, popularity? }
 * @returns {{ score: number, matches: string[] }}
 */
export function scoreEntry(query, entry) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return { score: 0, matches: [] }

  const name = String(entry.name ?? '').toLowerCase()
  const id = String(entry.id ?? '').toLowerCase()
  const aliases = (entry.aliases ?? []).map((a) => String(a).toLowerCase())

  const matches = []
  let raw = 0

  if (name === q || id === q) {
    raw = 1.0
    matches.push('名称精确匹配')
  } else if (aliases.includes(q)) {
    raw = 0.95
    matches.push('别名精确匹配')
  } else if (name.startsWith(q) || id.startsWith(q)) {
    raw = 0.9
    matches.push('名称前缀匹配')
  } else if (aliases.some((a) => a.startsWith(q) || q.startsWith(a))) {
    raw = 0.85
    matches.push('别名前缀匹配')
  } else {
    // 词元重叠：名称命中权重大于摘要命中
    const qTokens = tokenSet(q)
    const nameTokens = tokenSet(name + ' ' + id + ' ' + aliases.join(' '))
    const summaryTokens = tokenSet(entry.summary ?? '')
    const nameHits = [...qTokens].filter((t) => nameTokens.has(t)).length
    const summaryHits = [...qTokens].filter((t) => summaryTokens.has(t)).length
    if (nameHits > 0) {
      const ratio = nameHits / qTokens.size
      // 上限 0.83：即使满命中+最大流行度微调（0.83+0.17×0.1=0.847）
      // 也低于别名前缀层的 0.85，保证层级顺序恒成立
      raw = 0.6 + 0.23 * Math.min(1, ratio)
      matches.push(`名称词元命中 ${nameHits}/${qTokens.size}`)
    } else if (summaryHits > 0) {
      const ratio = summaryHits / qTokens.size
      raw = 0.3 + 0.2 * Math.min(1, ratio)
      matches.push(`摘要词元命中 ${summaryHits}/${qTokens.size}`)
    }
  }

  if (raw === 0) {
    // 一个信号都没有：不给分数（由调用方过滤掉）
    return { score: 0, matches: [] }
  }

  const score = Math.min(1, raw + (1 - raw) * popularityBoost(entry.popularity))
  return { score: Number(score.toFixed(4)), matches }
}

/**
 * 对同一查询的多个条目排序（稳定：同分按流行度降序）。
 * @returns 按 score 降序、含评分信息的条目列表
 */
export function rankEntries(query, entries) {
  const scored = entries
    .map((entry) => {
      const { score, matches } = scoreEntry(query, entry)
      return { entry, score, matches }
    })
    .filter((item) => item.score > 0)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return Number(b.entry.popularity ?? 0) - Number(a.entry.popularity ?? 0)
  })
  return scored
}

/** 片段标题词元的权重（标题命中远比正文命中重要） */
const HEADING_WEIGHT = 2

/**
 * 对文档片段按查询相关度排序。
 * @param {string} query 用户聚焦点（可为空串：空时全部保留，按原始顺序）
 * @param {Array<{heading: string, body: string}>} sections 片段列表
 * @param {number} max 最多返回多少片
 * @returns {Array<{heading, body, score, matches}>} 分数降序
 */
export function rankSections(query, sections, max) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) {
    return sections.slice(0, max).map((s) => ({ ...s, score: 0, matches: [] }))
  }
  const qTokens = tokenSet(q)
  const scored = []
  for (const section of sections) {
    const headingTokens = tokenSet(section.heading ?? '')
    const bodyTokens = tokenSet(section.body ?? '')
    let headingHits = 0
    let bodyHits = 0
    for (const token of qTokens) {
      if (headingTokens.has(token)) headingHits += 1
      else if (bodyTokens.has(token)) bodyHits += 1
    }
    const hits = headingHits + bodyHits
    if (hits === 0) continue
    const score = (HEADING_WEIGHT * headingHits + bodyHits) / (HEADING_WEIGHT * qTokens.size)
    scored.push({
      ...section,
      score: Number(Math.min(1, score).toFixed(4)),
      matches: [
        ...(headingHits > 0 ? [`标题命中 ${headingHits} 词`] : []),
        ...(bodyHits > 0 ? [`正文命中 ${bodyHits} 词`] : []),
      ],
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, max)
}
