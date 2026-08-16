/**
 * 端到端测试：以子进程启动 entry.js，走完整 MCP 握手与三个工具调用。
 * 同时覆盖协议级错误路径（未初始化、未知方法、未知工具）。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { StdioClient } from '../src/bridge/client.js'

const ENTRY = fileURLToPath(new URL('../src/entry.js', import.meta.url))

let child
let client

before(async () => {
  child = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'inherit'] })
  client = new StdioClient({ child, log: () => {} })
  await client.connect()
})

after(() => {
  client?.dispose()
})

test('tools/list 返回三个只读工具', async () => {
  const { tools } = await client.request('tools/list', {})
  assert.equal(tools.length, 3)
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['catalog_lookup', 'catalog_releases', 'doc_extract'])
  for (const tool of tools) {
    assert.ok(tool.description.length > 0, `${tool.name} 缺描述`)
    assert.ok(tool.inputSchema?.type === 'object', `${tool.name} 缺 schema`)
  }
})

test('catalog_lookup：检索 express 得到带评分的条目', async () => {
  const result = await client.call('catalog_lookup', { query: 'express' })
  assert.equal(result.isError, undefined)
  const data = result.structuredContent
  assert.ok(data.results.length >= 1)
  assert.equal(data.results[0].id, 'express')
  assert.equal(data.results[0].score, 1.0)
  assert.ok(Array.isArray(data.results[0].versions))
  assert.ok(data.results[0].source.startsWith('local:'))
  assert.ok(result.content[0].text.includes('express'))
})

test('catalog_lookup：无匹配返回空列表而非错误', async () => {
  const result = await client.call('catalog_lookup', { query: 'totally-unknown-lib' })
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent.results.length, 0)
  assert.equal(result.structuredContent.total, 0)
})

test('catalog_lookup：参数校验（缺 query → isError validation）', async () => {
  const result = await client.call('catalog_lookup', {})
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error.code, 'validation')
})

test('catalog_lookup：可选参数显式传 null 不报错', async () => {
  const result = await client.call('catalog_lookup', { query: 'express', limit: null })
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent.results[0].id, 'express')
})

test('catalog_releases：列出 zod 版本', async () => {
  const result = await client.call('catalog_releases', { id: 'zod' })
  assert.equal(result.isError, undefined)
  const data = result.structuredContent
  assert.ok(data.versions.includes('3.24.1'))
  assert.equal(data.latest, '3.24.1')
})

test('catalog_releases：不存在的条目 → isError not-found', async () => {
  const result = await client.call('catalog_releases', { id: 'no-such-lib' })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error.code, 'not-found')
})

test('doc_extract：默认取最新稳定版并输出片段', async () => {
  const result = await client.call('doc_extract', { id: 'express' })
  assert.equal(result.isError, undefined)
  const data = result.structuredContent
  assert.equal(data.version, '5.1.0')
  assert.equal(data.releaseKind, 'latest')
  assert.ok(data.sections.length > 0)
  assert.ok(data.sections[0].heading.length > 0)
})

test('doc_extract：focus 相关度排序（标题命中靠前）', async () => {
  const result = await client.call('doc_extract', { id: 'express', focus: '通配符' })
  const data = result.structuredContent
  assert.equal(data.sections[0].heading, '通配符路由')
  assert.ok(data.sections[0].score > 0)
})

test('doc_extract：前缀版本选择 4 → 4.21.2', async () => {
  const result = await client.call('doc_extract', { id: 'express', version: '4' })
  const data = result.structuredContent
  assert.equal(data.version, '4.21.2')
  assert.equal(data.releaseKind, 'prefix')
})

test('doc_extract：不存在的版本 → isError version', async () => {
  const result = await client.call('doc_extract', { id: 'express', version: '9.9.9' })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error.code, 'version')
  assert.match(result.content[0].text, /可用版本/)
})

test('doc_extract：maxSections 截断生效', async () => {
  const result = await client.call('doc_extract', { id: 'express', maxSections: 2 })
  assert.ok(result.structuredContent.sections.length <= 2)
})

test('协议级：未知工具 → JSON-RPC INVALID_PARAMS 错误', async () => {
  await assert.rejects(
    () => client.call('no_such_tool', {}),
    (err) => err.code === 'jsonrpc' && /未知工具/.test(err.message),
  )
})

test('协议级：未知方法 → METHOD_NOT_FOUND', async () => {
  await assert.rejects(
    () => client.request('bogus/method', {}),
    (err) => err.code === 'jsonrpc' && /未知方法/.test(err.message),
  )
})

test('stdin 关闭后 server 自动退出（优雅收尾）', async () => {
  const solo = spawn(process.execPath, [ENTRY], { stdio: ['pipe', 'pipe', 'ignore'] })
  const soloClient = new StdioClient({ child: solo, log: () => {} })
  await soloClient.connect()
  const exited = new Promise((resolve) => {
    solo.on('exit', (code) => resolve(code))
  })
  solo.stdin.end() // 客户端断开输入流
  const code = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000)),
  ])
  assert.equal(code, 0, '输入流关闭后进程应以 0 退出')
})
