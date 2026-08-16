/**
 * JSON-RPC 消息分类与构造单元测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, createResponse, createError, ERROR_CODES } from '../src/protocol/jsonrpc.js'

test('classify：请求/通知/响应/非法', () => {
  assert.equal(classify({ jsonrpc: '2.0', id: 1, method: 'ping' }), 'request')
  assert.equal(classify({ jsonrpc: '2.0', method: 'notifications/initialized' }), 'notification')
  assert.equal(classify({ jsonrpc: '2.0', id: 1, result: {} }), 'response')
  assert.equal(classify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }), 'response')
  assert.equal(classify(null), 'invalid')
  assert.equal(classify({}), 'invalid')
  assert.equal(classify({ jsonrpc: '1.0', id: 1, method: 'x' }), 'invalid')
  assert.equal(classify({ jsonrpc: '2.0', method: 'x', result: {} }), 'invalid') // 冲突消息
  assert.equal(classify([1, 2]), 'invalid')
})

test('classify：result 与 error 同现判非法；id 为 null 的请求合法', () => {
  assert.equal(classify({ jsonrpc: '2.0', id: 1, result: {}, error: { code: -1, message: 'x' } }), 'invalid')
  assert.equal(classify({ jsonrpc: '2.0', id: null, method: 'ping' }), 'request')
})

test('createResponse / createError 形状', () => {
  assert.deepEqual(createResponse(7, { ok: true }), { jsonrpc: '2.0', id: 7, result: { ok: true } })
  assert.deepEqual(createError(7, ERROR_CODES.METHOD_NOT_FOUND, '未知方法'), {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32601, message: '未知方法' },
  })
})
