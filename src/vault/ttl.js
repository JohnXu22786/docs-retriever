/**
 * TTL + LRU 内存缓存：
 *  - 每个条目带过期时间，读取时惰性淘汰过期项；
 *  - 容量上限用访问序 LRU 淘汰（Map 重插 = 置顶）；
 *  - 关闭缓存（ttlMs = 0）时退化为透传，不做任何存储。
 * 线程模型：Node 单线程事件循环内同步读写，无需加锁。
 */
export class TtlCache {
  /**
   * @param {object} opts
   * @param {number} opts.ttlMs 存活毫秒；0 表示禁用缓存
   * @param {number} [opts.maxEntries] 容量上限，默认 256
   */
  constructor({ ttlMs, maxEntries = 256 }) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.map = new Map() // key → { value, expiresAt }
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  get enabled() {
    return this.ttlMs > 0
  }

  /** 读取；命中返回存的值，未命中/已过期/已淘汰返回 undefined */
  get(key) {
    if (!this.enabled) return undefined
    const entry = this.map.get(key)
    if (!entry) {
      this.misses += 1
      return undefined
    }
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key)
      this.misses += 1
      return undefined
    }
    // 访问序 LRU：重插到末尾
    this.map.delete(key)
    this.map.set(key, entry)
    this.hits += 1
    return entry.value
  }

  set(key, value) {
    if (!this.enabled) return
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    if (this.map.size > this.maxEntries) {
      // 淘汰最久未访问的（Map 第一个键）
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) {
        this.map.delete(oldest)
        this.evictions += 1
      }
    }
  }

  clear() {
    this.map.clear()
  }

  /** 统计信息：命中/未命中/淘汰/当前大小 */
  stats() {
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      ttlMs: this.ttlMs,
    }
  }
}
