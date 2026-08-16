/**
 * 工具定义：目录检索 / 版本清单 / 文档提取。
 * 全部为只读操作（mutating: false），不修改任何外部状态。
 * 文本渲染保持简洁：检索结果只带关键元数据，节省模型的上下文预算。
 */
import { ToolRegistry } from './registry.js'

const TEXT = (content) => [{ type: 'text', text: content }]

export function buildRegistry(services) {
  const registry = new ToolRegistry()
  const { store, config } = services

  registry.register({
    name: 'catalog_lookup',
    description:
      '检索文档目录：按库/框架的名称或描述查找条目，返回带相关度评分与命中信号的候选列表。' +
      '当不确定库的规范 id 时，先调用本工具；后续用返回的 id 调用 doc_extract。' +
      '结果按评分降序，评分依据：名称精确/前缀/别名命中 > 摘要词元命中 > 流行度微调。',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: '要查找的库名或描述，如 "express" 或 "js 日期处理"（必填）' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回几条，默认 8' },
      },
      required: ['query'],
    },
    async execute(args) {
      const result = await store.lookup(args.query, { limit: args.limit ?? 8 })
      const lines = [
        `共 ${result.total} 个匹配条目（数据源：${result.sources.join('、') || '无'}）${result.results.length < result.total ? `，展示前 ${result.results.length} 条` : ''}：`,
      ]
      for (const r of result.results) {
        const versions = r.versions.length > 3 ? `${r.versions.slice(0, 3).join(', ')}…(+${r.versions.length - 3})` : r.versions.join(', ')
        lines.push(`• ${r.id} — ${r.name}（${r.summary}）`)
        lines.push(`  score=${r.score}（${r.matches.join('；') || '无信号'}）latest=${r.latest} versions=[${versions}] 来源=${r.source}`)
      }
      if (result.results.length === 0) {
        lines.push('没有找到匹配条目，请尝试换一个关键词。')
      }
      return {
        content: TEXT(lines.join('\n')),
        structuredContent: result,
      }
    },
  })

  registry.register({
    name: 'catalog_releases',
    description:
      '查看条目的可用版本清单与推荐版本。支持 "latest"、精确版本号（如 "5.1.0"）与' +
      '前缀（如 "5" 或 "5.1" 或 "5.1.x"）。先于 doc_extract 调用可确定目标版本是否可用。',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: '条目规范 id（catalog_lookup 返回）' },
      },
      required: ['id'],
    },
    async execute(args) {
      const result = await store.releases(args.id)
      const lines = [
        `${result.name}（${result.id}）可用 ${result.versions.length} 个版本：`,
        result.versions.map((v) => `  ${v}${v === result.latest ? ' ← 推荐（latest）' : ''}`).join('\n'),
        `来源：${result.source}`,
      ]
      return { content: TEXT(lines.join('\n')), structuredContent: result }
    },
  })

  registry.register({
    name: 'doc_extract',
    description:
      '提取文档：按条目 id、版本与聚焦点（focus）取回相关文档片段，片段按相关度评分降序。' +
      'focus 建议一次只描述一个概念（如 "路由参数"），跨概念问题分多次调用。' +
      'version 缺省取最新稳定版；支持精确版本号与前缀（如 "4"）。' +
      '返回中包含 releaseNote 说明版本选择依据、source 标注数据来源。',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, description: '条目规范 id（catalog_lookup 返回，必填）' },
        version: { type: 'string', minLength: 1, description: '目标版本：latest / 精确版本号 / 前缀（默认 latest）' },
        focus: { type: 'string', minLength: 1, description: '聚焦概念，用于对片段做相关度排序（可选）' },
        maxSections: { type: 'integer', minimum: 1, maximum: 12, description: '最多返回几个片段，默认 6' },
      },
      required: ['id'],
    },
    async execute(args) {
      const result = await store.extract(args.id, {
        version: args.version ?? null,
        focus: args.focus ?? null,
        maxSections: args.maxSections ?? 6,
      })
      const lines = [
        `# ${result.name}（${result.id}）@${result.version}  [${result.releaseNote}；来源 ${result.source}]`,
      ]
      if (result.volumeSummary) lines.push(`> ${result.volumeSummary}`)
      if (result.sections.length === 0) {
        lines.push('（没有与 focus 匹配的片段；可去掉 focus 重试，或换一个概念）')
      }
      for (const s of result.sections) {
        const score = s.score > 0 ? `  [score=${s.score}${s.matches.length ? `，${s.matches.join('，')}` : ''}]` : ''
        lines.push(`\n## ${s.heading}${score}`)
        lines.push(s.body)
      }
      return { content: TEXT(lines.join('\n')), structuredContent: result }
    },
  })

  return registry
}

export { ToolRegistry, validateArgs } from './registry.js'
