/**
 * TTL/LRU 缓存单元测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TtlCache } from '../src/vault/ttl.js'

test('基础读写与命中统计', () => {
  const cache = new TtlCache({ ttlMs: 10_000 })
  assert.equal(cache.get('a'), undefined)
  cache.set('a', 1)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.stats().hits, 1)
  assert.equal(cache.stats().misses, 1)
})

test('过期条目惰性淘汰', async () => {
  const cache = new TtlCache({ ttlMs: 30 })
  cache.set('a', 1)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.stats().size, 0)
})

test('LRU 淘汰最久未访问的条目', () => {
  const cache = new TtlCache({ ttlMs: 60_000, maxEntries: 2 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a') // a 变最新
  cache.set('c', 3) // 应淘汰 b
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('c'), 3)
  assert.equal(cache.stats().evictions, 1)
})

test('ttlMs=0 时缓存禁用：不存不读', () => {
  const cache = new TtlCache({ ttlMs: 0 })
  assert.equal(cache.enabled, false)
  cache.set('a', 1)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.stats().size, 0)
})

test('set 覆盖同键并刷新过期时间', async () => {
  const cache = new TtlCache({ ttlMs: 50 })
  cache.set('a', 1)
  cache.set('a', 2)
  assert.equal(cache.get('a'), 2)
  await new Promise((r) => setTimeout(r, 70))
  assert.equal(cache.get('a'), undefined)
})

test('clear 清空全部', () => {
  const cache = new TtlCache({ ttlMs: 60_000 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.clear()
  assert.equal(cache.stats().size, 0)
  assert.equal(cache.get('a'), undefined)
})

test('过期条目：命中计数归未命中，大小收缩', async () => {
  const cache = new TtlCache({ ttlMs: 20 })
  cache.set('a', 1)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.stats().hits, 0)
  assert.equal(cache.stats().misses, 1) // 过期淘汰计一次 miss
  assert.equal(cache.stats().size, 0)
  // 过期后重新 set 可继续使用
  cache.set('a', 2)
  assert.equal(cache.get('a'), 2)
})

test('maxEntries=0：写即淘汰但不应崩溃（空淘汰边缘）', () => {
  const cache = new TtlCache({ ttlMs: 60_000, maxEntries: 0 })
  cache.set('a', 1)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.stats().size, 0)
  assert.equal(cache.stats().evictions, 1)
})

test('LRU：已存在的键重写不重复计数，且置为最新', () => {
  const cache = new TtlCache({ ttlMs: 60_000, maxEntries: 2 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('a', 10) // a 重写并置顶
  cache.set('c', 3) // 应淘汰 b（最久未访问）
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 10)
  assert.equal(cache.get('c'), 3)
})
