/**
 * 数据源供给层：文档索引的两种获取方式。
 *
 *  - LocalSource：读取本地 JSON 索引文件（默认内置 data/index.json），
 *    离线可用、永远成功（文件损坏除外）；
 *  - RemoteSource：从远程 URL 拉取索引（baseUrl + '/index.json'），
 *    结果进 TTL 缓存；失败写短冷却负缓存并抛 NETWORK/TIMEOUT，
 *    由 CatalogStore 降级到本地。
 *
 * 索引格式：{ format: 'doctrove-index@1', updatedAt, entries: [...] }
 * 详见 README「索引格式与自建索引」。
 */
import { readFileSync } from 'node:fs'
import { DoctroveError, ErrorCodes } from '../core/errors.js'
import { TtlCache } from '../vault/ttl.js'

export const INDEX_FORMAT = 'doctrove-index@1'

/** 校验索引形状；非法返回错误信息，合法返回 null */
export function validateIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    return '索引顶层必须是对象'
  }
  if (index.format !== INDEX_FORMAT) {
    return `不支持的索引格式 "${index.format}"（应为 ${INDEX_FORMAT}）`
  }
  if (!Array.isArray(index.entries)) {
    return '索引缺少 entries 数组'
  }
  const ids = new Set()
  for (const entry of index.entries) {
    if (!entry || typeof entry !== 'object') return 'entries 中存在非法条目'
    if (typeof entry.id !== 'string' || entry.id === '') return '条目缺少 id'
    if (ids.has(entry.id)) return `条目 id 重复：${entry.id}`
    ids.add(entry.id)
    if (typeof entry.name !== 'string' || entry.name === '') return `条目 ${entry.id} 缺少 name`
    if ('aliases' in entry && (!Array.isArray(entry.aliases) || entry.aliases.some((a) => typeof a !== 'string'))) {
      return `条目 ${entry.id} 的 aliases 必须是字符串数组`
    }
    if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
      return `条目 ${entry.id} 缺少 versions`
    }
    if (!entry.volumes || typeof entry.volumes !== 'object') {
      return `条目 ${entry.id} 缺少 volumes`
    }
    for (const v of entry.versions) {
      const volume = entry.volumes[v]
      if (!volume || !Array.isArray(volume.sections)) {
        return `条目 ${entry.id} 的版本 ${v} 缺少 sections`
      }
      if (volume.sections.some((s) => !s || typeof s !== 'object' || Array.isArray(s))) {
        return `条目 ${entry.id} 的版本 ${v} 的 sections 中存在非法元素`
      }
    }
  }
  return null
}

/** 本地数据源：同步读取单个索引文件 */
export class LocalSource {
  /**
   * @param {object} opts
   * @param {string} opts.path 索引文件绝对/相对路径
   * @param {Function} [opts.log]
   */
  constructor({ path, log = () => {} }) {
    this.path = path
    this.log = log
    this._cached = null // 同一进程内只读一次（索引是静态数据）
  }

  /** @returns {Promise<{ index: object, label: string, cached: boolean }>} */
  async load() {
    if (this._cached) return { index: this._cached, label: `local:${this.path}`, cached: true }
    let raw
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (err) {
      throw new DoctroveError(`无法读取本地索引 ${this.path}：${err.message}`, { code: ErrorCodes.CONFIG })
    }
    let index
    try {
      index = JSON.parse(raw)
    } catch (err) {
      throw new DoctroveError(`本地索引 ${this.path} 不是合法 JSON：${err.message}`, { code: ErrorCodes.CONFIG })
    }
    const problem = validateIndex(index)
    if (problem) {
      throw new DoctroveError(`本地索引 ${this.path} 校验失败：${problem}`, { code: ErrorCodes.CONFIG })
    }
    this._cached = index
    this.log(`本地索引已加载（${this.path}，${index.entries.length} 个条目）`)
    return { index, label: `local:${this.path}`, cached: false }
  }
}

/** 远程数据源：HTTP 拉取索引（baseUrl + '/index.json'），带 TTL 缓存与失败冷却 */
export class RemoteSource {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl 如 https://docs.example.com/index
   * @param {import('../vault/ttl.js').TtlCache} opts.cache
   * @param {number} opts.timeoutMs
   * @param {number} [opts.failCooldownMs] 失败后短冷却期（负缓存），避免宕机时每次查询干等超时，默认 30s
   * @param {string} [opts.userAgent]
   * @param {Function} [opts.log]
   * @param {Function} [opts.fetchImpl] 测试注入用
   */
  constructor({
    baseUrl, cache, timeoutMs, failCooldownMs = 30_000,
    userAgent = 'doctrove/1.0.0', log = () => {}, fetchImpl = globalThis.fetch,
  }) {
    this.baseUrl = baseUrl
    this.cache = cache
    this.timeoutMs = timeoutMs
    this.failCooldownMs = failCooldownMs
    this.userAgent = userAgent
    this.log = log
    this.fetchImpl = fetchImpl
    this.cacheKey = `remote:${baseUrl}/index.json`
    this.failKey = `remote:${baseUrl}/fail`
    // 失败冷却负缓存独立于主缓存 TTL：若主缓存 TTL 短于冷却期，
    // 冷却条目会在冷却结束前被提前淘汰，宕机期间每个查询都会重复
    // 等待一次网络超时。冷却条目单独存储、TTL 至少为冷却期。
    this.failCache = cache.enabled
      ? new TtlCache({ ttlMs: Math.max(failCooldownMs, cache.ttlMs), maxEntries: 4 })
      : null
  }

  /** @returns {Promise<{ index: object, label: string, cached: boolean }>} */
  async load() {
    const hit = this.cache.get(this.cacheKey)
    if (hit) {
      this.log(`远程索引命中缓存（${this.baseUrl}）`)
      return { index: hit, label: `remote:${this.baseUrl}`, cached: true }
    }
    const cooldown = this.failCache?.get(this.failKey)
    if (cooldown !== undefined && Date.now() - cooldown.at < this.failCooldownMs) {
      // 负缓存：冷却期内直接抛错，由 CatalogStore 降级到本地，不再发起网络请求。
      // 冷却判断用自身时间戳（failCooldownMs），不受缓存 TTL 影响；
      // 缓存被禁用（--no-cache）时负缓存不写入，每次都真实请求。
      throw new DoctroveError(
        `远程索引暂不可用（${this.baseUrl}，冷却期内自动跳过，稍后重试）`,
        { code: ErrorCodes.NETWORK },
      )
    }

    const url = `${this.baseUrl}/index.json`
    let response
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: 'application/json',
          'user-agent': this.userAgent,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      this.failCache?.set(this.failKey, { at: Date.now() })
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new DoctroveError(`拉取远程索引超时（${url}，${this.timeoutMs}ms）`, {
          code: ErrorCodes.TIMEOUT,
          cause: err,
        })
      }
      throw new DoctroveError(`拉取远程索引失败（${url}）：${err?.message ?? err}`, {
        code: ErrorCodes.NETWORK,
        cause: err,
      })
    }
    if (!response.ok) {
      this.failCache?.set(this.failKey, { at: Date.now() })
      throw new DoctroveError(`远程索引返回 HTTP ${response.status}（${url}）`, { code: ErrorCodes.NETWORK })
    }
    let index
    try {
      index = await response.json()
    } catch (err) {
      this.failCache?.set(this.failKey, { at: Date.now() })
      throw new DoctroveError(`远程索引响应不是合法 JSON（${url}）：${err?.message ?? err}`, {
        code: ErrorCodes.NETWORK,
        cause: err,
      })
    }
    const problem = validateIndex(index)
    if (problem) {
      this.failCache?.set(this.failKey, { at: Date.now() })
      throw new DoctroveError(`远程索引校验失败（${url}）：${problem}`, { code: ErrorCodes.NETWORK })
    }
    this.cache.set(this.cacheKey, index)
    this.log(`远程索引已拉取（${url}，${index.entries.length} 个条目）`)
    return { index, label: `remote:${this.baseUrl}`, cached: false }
  }
}
