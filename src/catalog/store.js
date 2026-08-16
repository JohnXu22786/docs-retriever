/**
 * 目录中枢：多数据源的合并、检索、版本选择与文档提取。
 *
 * 数据源顺序：远程（若配置）在前，本地兜底在后。
 *  - 远程索引拉取失败 → 自动降级到本地索引，条目带 source 标注；
 *  - 同一 id 在多个源出现时，靠前的源优先；
 *  - 检索与提取全部只读，无副作用。
 */
import { DoctroveError, ErrorCodes } from '../core/errors.js'
import { rankEntries, rankSections } from './scoring.js'
import { selectRelease, pickLatest } from './releases.js'

export class CatalogStore {
  /**
   * @param {object} opts
   * @param {Array<{label: string, load: () => Promise<{index: object}>}>} opts.sources
   * @param {Function} [opts.log]
   */
  constructor({ sources, log = () => {} }) {
    this.sources = sources
    this.log = log
    this._loaded = null // Promise 化的装载结果缓存：多次请求只装载一次
  }

  /** 装载全部可用源；单个源失败只记录日志，不影响其他源 */
  async _indexes() {
    if (this._loaded) return this._loaded
    this._loaded = (async () => {
      const loaded = []
      for (const source of this.sources) {
        try {
          const { index, label } = await source.load()
          loaded.push({ index, label })
        } catch (err) {
          this.log(`数据源 ${source.label ?? '?'} 不可用：${err?.message ?? err}`)
        }
      }
      if (loaded.length === 0) {
        throw new DoctroveError('没有任何数据源可用（远程索引不可达且本地索引缺失）', {
          code: ErrorCodes.NETWORK,
        })
      }
      return loaded
    })()
    try {
      return await this._loaded
    } finally {
      // 只去重并发、不缓存结果：刷新频率交给数据源各自的 TTL/静态缓存，
      // 这样远程索引更新能生效、失败的源能在进程内自愈重试。
      this._loaded = null
    }
  }

  /** 所有源里的条目，靠前的源优先；重复 id 只保留第一个 */
  async _entries() {
    const indexes = await this._indexes()
    const seen = new Set()
    const entries = []
    for (const { index, label } of indexes) {
      for (const entry of index.entries) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        entries.push({ ...entry, _source: label })
      }
    }
    return entries
  }

  /** 找条目：先精确 id，再别名，再大小写不敏感 id */
  async findEntry(id) {
    const entries = await this._entries()
    const normalized = String(id ?? '').trim()
    if (!normalized) return null
    return entries.find((e) => e.id === normalized)
      ?? entries.find((e) => (e.aliases ?? []).some((a) => String(a) === normalized))
      ?? entries.find((e) => e.id.toLowerCase() === normalized.toLowerCase())
      ?? null
  }

  /**
   * 检索目录：评分 → 排序 → 截断。
   * @returns {Promise<{ results: Array, total: number, source: string|null }>}
   */
  async lookup(query, { limit = 8 } = {}) {
    const entries = await this._entries()
    const scored = rankEntries(query, entries)
    const results = scored.slice(0, limit).map(({ entry, score, matches }) => ({
      id: entry.id,
      name: entry.name,
      summary: entry.summary ?? '',
      popularity: Number(entry.popularity ?? 0),
      versions: entry.versions,
      latest: pickLatest(entry.versions) ?? entry.versions.at(-1),
      score,
      matches,
      source: entry._source,
    }))
    const sources = new Set(entries.map((e) => e._source))
    return {
      results,
      total: scored.length,
      sources: [...sources],
    }
  }

  /**
   * 版本清单：找条目并返回版本信息；找不到抛 NOT_FOUND。
   * @returns {Promise<{ id, name, latest, versions, source }>}
   */
  async releases(id) {
    const entry = await this.findEntry(id)
    if (!entry) {
      throw new DoctroveError(
        `目录中找不到条目 "${id}"。请先用 catalog_lookup 检索确认正确的 id（支持别名与大小写不敏感匹配）。`,
        { code: ErrorCodes.NOT_FOUND },
      )
    }
    return {
      id: entry.id,
      name: entry.name,
      latest: pickLatest(entry.versions) ?? entry.versions.at(-1),
      versions: entry.versions,
      source: entry._source,
    }
  }

  /**
   * 提取文档：解析版本 → 按聚焦点排序片段。
   * @returns {Promise<{ id, name, version, versions, releaseKind, note, sections, source }>}
   */
  async extract(id, { version = null, focus = null, maxSections = 6 } = {}) {
    const entry = await this.findEntry(id)
    if (!entry) {
      throw new DoctroveError(
        `目录中找不到条目 "${id}"。请先用 catalog_lookup 检索确认正确的 id（支持别名与大小写不敏感匹配）。`,
        { code: ErrorCodes.NOT_FOUND },
      )
    }
    const selection = selectRelease(version, entry.versions)
    const volume = entry.volumes[selection.version]
    const sections = rankSections(focus, volume.sections, maxSections)
    return {
      id: entry.id,
      name: entry.name,
      version: selection.version,
      versions: entry.versions,
      releaseKind: selection.kind,
      releaseNote: selection.note,
      volumeSummary: volume.summary ?? '',
      sections,
      source: entry._source,
    }
  }
}

export { INDEX_FORMAT } from '../supply/provider.js'
export { selectRelease, pickLatest } from './releases.js'
