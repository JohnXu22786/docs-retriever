/**
 * MCP 引擎单元测试：初始化门禁、协议版本协商、ping、结果形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpEngine, PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from '../src/protocol/engine.js'
import { buildRegistry } from '../src/tools/definitions.js'
import { CatalogStore } from '../src/catalog/store.js'
import { LocalSource } from '../src/supply/provider.js'
import { fileURLToPath } from 'node:url'
import { ERROR_CODES } from '../src/protocol/jsonrpc.js'

const LOCAL = fileURLToPath(new URL('../data/index.json', import.meta.url))

function makeEngine() {
  const store = new CatalogStore({ sources: [new LocalSource({ path: LOCAL })], log: () => {} })
  const services = { store, config: {}, version: { name: 'doctrove', version: 'test' } }
  const registry = buildRegistry(services)
  return new McpEngine({ registry, services, serverInfo: { name: 'doctrove', version: 'test' } })
}

test('未初始化时调用 tools/list 返回 -32002', async () => {
  const engine = makeEngine()
  const reply = await engine.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  assert.equal(reply.error.code, -32002)
  assert.match(reply.error.message, /initialize/)
})

test('initialize 协商：回显客户端支持的最新版本', async () => {
  const engine = makeEngine()
  const reply = await engine.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {} },
  })
  assert.equal(reply.result.protocolVersion, '2024-11-05')
  assert.deepEqual(reply.result.capabilities, { tools: {} })
})

test('initialize 协商：未知版本回退到自身最新版', async () => {
  const engine = makeEngine()
  const reply = await engine.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2099-01-01' },
  })
  assert.equal(reply.result.protocolVersion, LATEST_PROTOCOL_VERSION)
  assert.ok(PROTOCOL_VERSIONS.includes(LATEST_PROTOCOL_VERSION))
})

test('ping 返回空结果', async () => {
  const engine = makeEngine()
  await engine.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const reply = await engine.handle({ jsonrpc: '2.0', id: 2, method: 'ping' })
  assert.deepEqual(reply.result, {})
})

test('通知不产生响应', async () => {
  const engine = makeEngine()
  const reply = await engine.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(reply, null)
})

test('非法消息 → INVALID_REQUEST', async () => {
  const engine = makeEngine()
  const reply = await engine.handle({ jsonrpc: '2.0', method: 'x', result: {} })
  assert.equal(reply.error.code, ERROR_CODES.INVALID_REQUEST)
})

test('工具结果：结构化内容 + 文本内容', async () => {
  const engine = makeEngine()
  await engine.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const reply = await engine.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'catalog_lookup', arguments: { query: 'dayjs' } },
  })
  assert.equal(reply.error, undefined)
  assert.equal(reply.result.structuredContent.results[0].id, 'dayjs')
  assert.ok(reply.result.content[0].text.length > 0)
})

test('工具错误折叠为 isError 而非协议错误', async () => {
  const engine = makeEngine()
  await engine.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  const reply = await engine.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'doc_extract', arguments: { id: 'ghost' } },
  })
  assert.equal(reply.error, undefined)
  assert.equal(reply.result.isError, true)
  assert.equal(reply.result.structuredContent.error.code, 'not-found')
})
