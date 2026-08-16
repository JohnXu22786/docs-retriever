/**
 * 配置加载单元测试：优先级、非法值、别名写法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadConfig, parseArgs } from '../src/core/config.js'

const ENV = {}

test('默认配置：无远程索引，缓存 600s，内置本地索引', () => {
  const cfg = loadConfig([], ENV)
  assert.equal(cfg.indexUrl, null)
  assert.equal(cfg.cacheTtlMs, 600_000)
  assert.equal(cfg.timeoutMs, 15_000)
  assert.match(cfg.localIndex, /index\.json$/)
  assert.equal(cfg.debug, false)
})

test('优先级：flag > env > 配置文件 > 默认', () => {
  const cfg = loadConfig(
    ['--index-url', 'https://flag.example.com/index/', '--timeout-ms', '999'],
    { DOCTROVE_INDEX_URL: 'https://env.example.com', DOCTROVE_TIMEOUT_MS: '111' },
  )
  assert.equal(cfg.indexUrl, 'https://flag.example.com/index') // 尾斜杠被去掉
  assert.equal(cfg.timeoutMs, 999)
})

test('配置文件加载与合并（env 次优先）', () => {
  const file = fileURLToPath(new URL('./fixtures/config-good.json', import.meta.url))
  const cfg = loadConfig(['--config', file], {})
  assert.equal(cfg.indexUrl, 'https://file.example.com/index')
  assert.equal(cfg.timeoutMs, 7000)
  assert.equal(cfg.cacheTtlMs, 123_000)
})

test('--no-cache 等价 cacheTtl 0', () => {
  assert.equal(loadConfig(['--no-cache'], ENV).cacheTtlMs, 0)
  assert.equal(loadConfig(['--cache-ttl', '0'], ENV).cacheTtlMs, 0)
  assert.equal(loadConfig(['--cache-ttl', '120'], ENV).cacheTtlMs, 120_000)
})

test('非法值拒绝：超时范围、TTL 范围、URL 协议', () => {
  assert.throws(() => loadConfig(['--timeout-ms', '0'], ENV), (e) => e.code === 'config')
  assert.throws(() => loadConfig(['--timeout-ms', '999999'], ENV), (e) => e.code === 'config')
  assert.throws(() => loadConfig(['--cache-ttl', '-1'], ENV), (e) => e.code === 'config')
  assert.throws(() => loadConfig(['--cache-ttl', '999999'], ENV), (e) => e.code === 'config')
  assert.throws(() => loadConfig(['--index-url', 'ftp://x.com'], ENV), (e) => e.code === 'config')
  assert.throws(() => loadConfig(['--index-url', 'not a url'], ENV), (e) => e.code === 'config')
  assert.throws(() => loadConfig(['--timeout-ms'], ENV), (e) => e.code === 'config')
})

test('help/version 优先返回，不读取配置文件', () => {
  assert.deepEqual(loadConfig(['--help'], ENV), { help: true, version: false })
  assert.deepEqual(loadConfig(['--version'], ENV), { version: true, help: false })
})

test('不支持的参数与位置参数报错', () => {
  assert.throws(() => loadConfig(['--bogus'], ENV), (e) => e.code === 'config')
  assert.throws(() => loadConfig(['positional'], ENV), (e) => e.code === 'config')
})

test('parseArgs：= 号写法', () => {
  assert.deepEqual(parseArgs(['--cache-ttl=30']), { 'cache-ttl': '30' })
  assert.throws(() => parseArgs(['--no-cache=1']))
})

test('配置文件 cacheTtl: 0 合法（关闭缓存，不被回退吞掉）', () => {
  const file = fileURLToPath(new URL('./fixtures/config-ttl-zero.json', import.meta.url))
  const cfg = loadConfig(['--config', file], ENV)
  assert.equal(cfg.cacheTtlMs, 0)
  assert.equal(cfg.timeoutMs, 15_000, '未写 timeoutMs 时应为默认值')
})

test('配置文件 timeoutMs: 0 落入非法值报错而非静默回退', () => {
  const file = fileURLToPath(new URL('./fixtures/config-zero.json', import.meta.url))
  assert.throws(() => loadConfig(['--config', file], { DOCTROVE_CACHE_TTL: '600' }), (e) => e.code === 'config')
})

test('localIndex 非字符串值被拒绝（防 fs 把数字当文件描述符）', () => {
  // 数字 0 会被 readFileSync 解释为 fd 0（stdin = MCP 协议通道），必须拦在配置层
  const file = fileURLToPath(new URL('./fixtures/config-localindex.json', import.meta.url))
  assert.throws(() => loadConfig(['--config', file], ENV), (e) => e.code === 'config' && /localIndex/.test(e.message))
})

test('配置文件损坏时报错而非崩溃', () => {
  const file = fileURLToPath(new URL('./fixtures/config-broken.json', import.meta.url))
  assert.throws(() => loadConfig(['--config', file], ENV), (e) => e.code === 'config')
})

test('环境变量布尔解析：true/1/yes/on', () => {
  assert.equal(loadConfig([], { DOCTROVE_DEBUG: 'yes' }).debug, true)
  assert.equal(loadConfig([], { DOCTROVE_DEBUG: 'off' }).debug, false)
})

test('空字符串视为未设置（环境变量与配置文件路径）', () => {
  // CLI 显式给空值属于用户错误，parseArgs 直接拒绝
  assert.throws(() => loadConfig(['--index-url', ''], ENV), (e) => e.code === 'config')
  // 环境变量里的空字符串则回退到默认（三个键行为一致）
  assert.equal(loadConfig([], { DOCTROVE_INDEX_URL: '' }).indexUrl, null)
  assert.equal(loadConfig([], { DOCTROVE_INDEX_URL: undefined }).indexUrl, null)
  assert.match(loadConfig([], { DOCTROVE_LOCAL_INDEX: '' }).localIndex, /index\.json$/)
  assert.equal(loadConfig([], { DOCTROVE_CACHE_TTL: '' }).cacheTtlMs, 600_000)
  assert.equal(loadConfig([], { DOCTROVE_TIMEOUT_MS: '' }).timeoutMs, 15_000)
})
