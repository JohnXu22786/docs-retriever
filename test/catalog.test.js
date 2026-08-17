/**
 * 目录中枢测试：多源合并、降级、检索、提取、错误路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogStore } from '../src/catalog/store.js'
import { TtlCache } from '../src/vault/ttl.js'
import { LocalSource, RemoteSource, validateIndex } from '../src/supply/provider.js'

/** 一个可注入 fetch 的远程源 */
function fakeRemoteSource({ baseUrl, fetchImpl, cache, failCooldownMs = 30_000, log = () => {} }) {
  return new RemoteSource({
    baseUrl,
    cache,
    timeoutMs: 5000,
    failCooldownMs,
    userAgent: 'test',
    log,
    fetchImpl,
  })
}

function sampleIndex(extra = {}) {
  return {
    format: 'doctrove-index@1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: [
      {
        id: 'demo',
        name: 'DemoKit',
        summary: '测试用库',
        popularity: 50,
        versions: ['2.1.0', '2.0.3', '1.9.0'],
        volumes: {
          '2.1.0': {
            summary: 'v2 新特性',
            sections: [
              { heading: '安装', body: 'npm install demokit' },
              { heading: '路由参数', body: 'app.get 的 req.params 用法' },
            ],
          },
          '2.0.3': {
            sections: [
              { heading: '安装', body: 'npm install demokit@2.0.3' },
            ],
          },
          '1.9.0': {
            sections: [
              { heading: '安装', body: 'npm install demokit@1.9.0' },
            ],
          },
        },
      },
      ...(extra.entries ?? []),
    ],
  }
}

/** 把内存索引写入临时文件，返回 LocalSource */
function tempLocalSource(index) {
  const dir = mkdtempSync(join(tmpdir(), 'doctrove-test-'))
  const path = join(dir, 'index.json')
  writeFileSync(path, JSON.stringify(index))
  const source = new LocalSource({ path })
  source._cleanup = () => rmSync(dir, { recursive: true, force: true })
  return source
}

test('validateIndex：格式与结构校验', () => {
  assert.equal(validateIndex({ format: 'other' }), '不支持的索引格式 "other"（应为 doctrove-index@1）')
  assert.equal(validateIndex({ format: 'doctrove-index@1', entries: [] }), null)
  assert.match(validateIndex({ format: 'doctrove-index@1', entries: [{}] }), /缺少 id/)
  const dup = sampleIndex()
  dup.entries.push(dup.entries[0])
  assert.match(validateIndex(dup), /id 重复/)
  const noVol = sampleIndex()
  delete noVol.entries[0].volumes
  assert.match(validateIndex(noVol), /缺少 volumes/)
})

test('validateIndex：aliases 非字符串数组必须被拒绝（防远程坏索引）', () => {
  const bad = sampleIndex()
  bad.entries[0].aliases = 'express' // 字符串而非数组
  assert.match(validateIndex(bad), /aliases 必须是字符串数组/)
  const badItem = sampleIndex()
  badItem.entries[0].aliases = [42]
  assert.match(validateIndex(badItem), /aliases 必须是字符串数组/)
})

test('validateIndex：sections 中的非法元素必须被拒绝（防 extract 崩溃）', () => {
  const bad = sampleIndex()
  bad.entries[0].volumes['2.1.0'].sections.push(null)
  assert.match(validateIndex(bad), /sections 中存在非法元素/)
  const bad2 = sampleIndex()
  bad2.entries[0].volumes['2.1.0'].sections.push([{ heading: 'x' }])
  assert.match(validateIndex(bad2), /sections 中存在非法元素/)
})

test('单本地源：检索、版本、提取全链路', async () => {
  const store = new CatalogStore({ sources: [tempLocalSource(sampleIndex())], log: () => {} })
  const lookup = await store.lookup('demo', { limit: 5 })
  assert.equal(lookup.results[0].id, 'demo')
  assert.ok(lookup.results[0].score > 0)
  assert.equal(lookup.results[0].latest, '2.1.0')
  assert.ok(lookup.results[0].source.startsWith('local:'))

  const releases = await store.releases('demo')
  assert.equal(releases.latest, '2.1.0')
  assert.deepEqual(releases.versions, ['2.1.0', '2.0.3', '1.9.0'])

  const extract = await store.extract('demo', { focus: '路由参数' })
  assert.equal(extract.version, '2.1.0')
  assert.equal(extract.releaseKind, 'latest')
  assert.ok(extract.sections.length >= 1)
  assert.equal(extract.sections[0].heading, '路由参数')

  const old = await store.extract('demo', { version: '2.0.3' })
  assert.equal(old.version, '2.0.3')
  assert.equal(old.releaseKind, 'exact')
})

test('lookup：无关查询返回空结果', async () => {
  const store = new CatalogStore({ sources: [tempLocalSource(sampleIndex())], log: () => {} })
  const lookup = await store.lookup('zzzqqq', { limit: 5 })
  assert.equal(lookup.results.length, 0)
  assert.equal(lookup.total, 0)
})

test('findEntry：别名与大小写不敏感', async () => {
  const store = new CatalogStore({ sources: [tempLocalSource(sampleIndex())], log: () => {} })
  assert.ok(await store.findEntry('Demo'))
  assert.ok(await store.findEntry('DEMO'))
  assert.equal(await store.findEntry('不存在'), null)
})

test('extract：找不到条目抛 NOT_FOUND', async () => {
  const store = new CatalogStore({ sources: [tempLocalSource(sampleIndex())], log: () => {} })
  await assert.rejects(() => store.extract('nope'), (err) => {
    assert.equal(err.code, 'not-found')
    assert.match(err.message, /catalog_lookup/)
    return true
  })
})

test('extract：版本不可用抛 VERSION 并提示候选', async () => {
  const store = new CatalogStore({ sources: [tempLocalSource(sampleIndex())], log: () => {} })
  await assert.rejects(() => store.extract('demo', { version: '9.9.9' }), (err) => {
    assert.equal(err.code, 'version')
    assert.match(err.message, /2\.1\.0/)
    return true
  })
})

test('多源合并：远程在前优先，远程失败自动降级本地', async () => {
  const cache = new TtlCache({ ttlMs: 60_000 })
  const okFetch = async (url) => {
    assert.match(url, /\/index\.json$/)
    return {
      ok: true,
      status: 200,
      json: async () => sampleIndex({
        entries: [{
          id: 'remote-only',
          name: 'RemoteOnly',
          summary: '只有远程源有',
          popularity: 10,
          versions: ['1.0.0'],
          volumes: { '1.0.0': { sections: [{ heading: 'r', body: 'remote' }] } },
        }],
      }),
    }
  }
  const local = tempLocalSource(sampleIndex())
  const store = new CatalogStore({
    sources: [
      fakeRemoteSource({ baseUrl: 'https://idx.example.com', fetchImpl: okFetch, cache }),
      local,
    ],
    log: () => {},
  })

  // 远程可用：remote-only 可检索，demo 命中远程优先
  const lookup = await store.lookup('RemoteOnly')
  assert.equal(lookup.results[0].id, 'remote-only')
  assert.ok(lookup.results[0].source.startsWith('remote:'))
  local._cleanup()

  // 远程故障：降级本地，demo 仍可用且标注 local
  const failFetch = async () => {
    throw new Error('connection refused')
  }
  const cache2 = new TtlCache({ ttlMs: 60_000 })
  const local2 = tempLocalSource(sampleIndex())
  const store2 = new CatalogStore({
    sources: [
      fakeRemoteSource({ baseUrl: 'https://down.example.com', fetchImpl: failFetch, cache: cache2 }),
      local2,
    ],
    log: () => {},
  })
  const viaLocal = await store2.lookup('demo')
  assert.equal(viaLocal.results[0].id, 'demo')
  assert.ok(viaLocal.results[0].source.startsWith('local:'))
  local2._cleanup()
})

test('远程源：非 2xx 抛 NETWORK；非法 JSON 抛 NETWORK；缓存命中后不再请求', async () => {
  const cache = new TtlCache({ ttlMs: 60_000 })
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => sampleIndex() }
  }
  const source = fakeRemoteSource({ baseUrl: 'https://c.example.com', fetchImpl, cache })
  await source.load()
  await source.load() // 第二次命中缓存
  assert.equal(calls, 1)

  const badStatus = fakeRemoteSource({
    baseUrl: 'https://s.example.com',
    fetchImpl: async () => ({ ok: false, status: 503 }),
    cache: new TtlCache({ ttlMs: 60_000 }),
  })
  await assert.rejects(() => badStatus.load(), (err) => err.code === 'network')

  const badJson = fakeRemoteSource({
    baseUrl: 'https://j.example.com',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => 'not json' }),
    cache: new TtlCache({ ttlMs: 60_000 }),
  })
  await assert.rejects(() => badJson.load(), (err) => err.code === 'network')
})

test('所有源失败时抛 NETWORK', async () => {
  const store = new CatalogStore({
    sources: [{
      label: 'broken',
      load: async () => { throw new Error('broken source') },
    }],
    log: () => {},
  })
  await assert.rejects(() => store.lookup('x'), (err) => err.code === 'network')
})

test('目录中枢不长期缓存装载结果：TTL 过期后远程源重新拉取', async () => {
  const cache = new TtlCache({ ttlMs: 20 })
  let fetchCalls = 0
  const fetchImpl = async () => {
    fetchCalls += 1
    return { ok: true, status: 200, json: async () => sampleIndex() }
  }
  const store = new CatalogStore({
    sources: [fakeRemoteSource({ baseUrl: 'https://refresh.example.com', fetchImpl, cache })],
    log: () => {},
  })
  await store.lookup('demo')
  assert.equal(fetchCalls, 1)
  await new Promise((r) => setTimeout(r, 40)) // 越过 TTL
  await store.lookup('demo')
  assert.equal(fetchCalls, 2, 'TTL 过期后应重新拉取远程索引')
})

test('目录中枢失败后可自愈：源恢复后不再报错', async () => {
  let down = true
  const cache = new TtlCache({ ttlMs: 20 })
  const fetchImpl = async () => {
    if (down) throw new Error('connection refused')
    return { ok: true, status: 200, json: async () => sampleIndex() }
  }
  const local = tempLocalSource(sampleIndex())
  const store = new CatalogStore({
    sources: [
      fakeRemoteSource({ baseUrl: 'https://recover.example.com', fetchImpl, cache, failCooldownMs: 20 }),
      local,
    ],
    log: () => {},
  })
  // 远程宕机 → 降级本地
  const degraded = await store.lookup('demo')
  assert.ok(degraded.results[0].source.startsWith('local:'))
  // 远程恢复 → 自动切回远程，无需重启进程（需越过失败冷却期）
  down = false
  await new Promise((r) => setTimeout(r, 40))
  const recovered = await store.lookup('demo')
  assert.ok(recovered.results[0].source.startsWith('remote:'))
  local._cleanup()
})

test('远程源失败冷却：冷却期内不发起请求，冷却后自动重试', async () => {
  const cache = new TtlCache({ ttlMs: 60_000 })
  let down = true
  let fetchCalls = 0
  const fetchImpl = async () => {
    fetchCalls += 1
    if (down) throw new Error('connection refused')
    return { ok: true, status: 200, json: async () => sampleIndex() }
  }
  const source = fakeRemoteSource({
    baseUrl: 'https://cooldown.example.com', fetchImpl, cache, failCooldownMs: 30,
  })
  await assert.rejects(() => source.load(), (err) => err.code === 'network')
  assert.equal(fetchCalls, 1)
  // 冷却期内：直接抛错，零网络请求
  await assert.rejects(() => source.load(), (err) => /冷却期/.test(err.message))
  assert.equal(fetchCalls, 1)
  // 冷却过后：自动重试并成功
  down = false
  await new Promise((r) => setTimeout(r, 50))
  const ok = await source.load()
  assert.equal(ok.cached, false)
  assert.equal(fetchCalls, 2)
})

test('远程源失败冷却：主缓存 TTL 短于冷却期时冷却仍完整生效', async () => {
  // 主缓存 TTL（10ms）远短于冷却期（250ms）：若冷却条目与负载共用存储，
  // 它会在冷却结束前被 TTL 淘汰，导致每个查询都重复发起网络请求。
  const cache = new TtlCache({ ttlMs: 10 })
  let down = true
  let fetchCalls = 0
  const fetchImpl = async () => {
    fetchCalls += 1
    if (down) throw new Error('connection refused')
    return { ok: true, status: 200, json: async () => sampleIndex() }
  }
  const source = fakeRemoteSource({
    baseUrl: 'https://shortttl.example.com', fetchImpl, cache, failCooldownMs: 250,
  })
  await assert.rejects(() => source.load(), (err) => err.code === 'network')
  // 冷却期内（约 100ms 真实耗时）的多次请求都不应触网
  // （主缓存 TTL 10ms 早已过期，冷却判定必须独立于它）
  await new Promise((r) => setTimeout(r, 40))
  await assert.rejects(() => source.load(), (err) => /冷却期/.test(err.message))
  await new Promise((r) => setTimeout(r, 40))
  await assert.rejects(() => source.load(), (err) => /冷却期/.test(err.message))
  assert.equal(fetchCalls, 1)
  // 越过冷却期：恢复后自动重试成功
  down = false
  await new Promise((r) => setTimeout(r, 300))
  const ok = await source.load()
  assert.equal(ok.cached, false)
  assert.equal(fetchCalls, 2)
})
