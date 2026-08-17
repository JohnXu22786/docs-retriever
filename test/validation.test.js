/**
 * 工具参数校验（validateArgs）单元测试：类型、必填、枚举、数值边界与数组项。
 * 覆盖 server.test.js 端到端之外的纯函数路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateArgs } from '../src/tools/registry.js'

const STRING_REQUIRED = { type: 'object', properties: { q: { type: 'string', minLength: 1 } }, required: ['q'] }
const INT_SPEC = { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 20 } } }
const ARRAY_SPEC = { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }
const ENUM_SPEC = { type: 'object', properties: { mode: { type: 'string', enum: ['regex', 'fixed'] } } }

function expectValidation(fn, pattern) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 'validation')
    assert.match(err.message, pattern)
    return true
  })
}

test('必填：缺失与显式 null 都拒绝', () => {
  expectValidation(() => validateArgs({}, STRING_REQUIRED, 't'), /缺少必填参数/)
  expectValidation(() => validateArgs({ q: null }, STRING_REQUIRED, 't'), /缺少必填参数/)
  const ok = validateArgs({ q: 'x' }, STRING_REQUIRED, 't')
  assert.equal(ok.q, 'x')
})

test('类型：字符串/整数/数组/对象逐一拒绝错误类型', () => {
  expectValidation(() => validateArgs({ q: 42 }, STRING_REQUIRED, 't'), /必须是字符串/)
  expectValidation(() => validateArgs({ n: '5' }, INT_SPEC, 't'), /必须是整数/)
  expectValidation(() => validateArgs({ n: 1.5 }, INT_SPEC, 't'), /必须是整数/)
  expectValidation(() => validateArgs({ tags: 'a' }, ARRAY_SPEC, 't'), /必须是数组/)
  expectValidation(() => validateArgs({ tags: ['a', 1] }, ARRAY_SPEC, 't'), /必须是字符串/)
})

test('数值边界：minimum/maximum 与 minLength', () => {
  expectValidation(() => validateArgs({ n: 0 }, INT_SPEC, 't'), /不能小于 1/)
  expectValidation(() => validateArgs({ n: 21 }, INT_SPEC, 't'), /不能大于 20/)
  assert.deepEqual(validateArgs({ n: 20 }, INT_SPEC, 't'), { n: 20 })
  expectValidation(() => validateArgs({ q: '' }, STRING_REQUIRED, 't'), /长度不能少于 1/)
})

test('枚举：越界拒绝，合法放行', () => {
  expectValidation(() => validateArgs({ mode: 'magic' }, ENUM_SPEC, 't'), /只能是：regex \/ fixed/)
  assert.deepEqual(validateArgs({ mode: 'fixed' }, ENUM_SPEC, 't'), { mode: 'fixed' })
})

test('宽松语义：可选参数 null/undefined 忽略、未知键忽略', () => {
  const spec = { type: 'object', properties: { q: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1 } }, required: ['q'] }
  const out = validateArgs({ q: 'x', limit: null, unknownKey: 'ignored' }, spec, 't')
  assert.deepEqual(out, { q: 'x', limit: null, unknownKey: 'ignored' })
})

test('非对象参数一律拒绝（数组/字符串/数字）', () => {
  expectValidation(() => validateArgs([1, 2], STRING_REQUIRED, 't'), /必须是对象/)
  expectValidation(() => validateArgs('x', STRING_REQUIRED, 't'), /必须是对象/)
  expectValidation(() => validateArgs(3, STRING_REQUIRED, 't'), /必须是对象/)
})
