/**
 * 版本选择单元测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVersion,
  compareVersions,
  isStable,
  pickLatest,
  selectRelease,
} from '../src/catalog/releases.js'

const VERSIONS = ['5.1.0', '5.0.1', '4.21.2', '4.20.0', '5.0.0-rc.1']

test('parseVersion：数字段与预发布', () => {
  assert.deepEqual(parseVersion('5.1.0'), { parts: [5, 1, 0], pre: null, raw: '5.1.0' })
  assert.deepEqual(parseVersion('v5.0.0-rc.1').parts, [5, 0, 0])
  assert.equal(parseVersion('v5.0.0-rc.1').pre, 'rc.1')
  assert.equal(parseVersion('abc').pre, 'abc')
})

test('parseVersion：build 元数据不视为预发布', () => {
  const v = parseVersion('1.0.0+build.2')
  assert.equal(v.pre, null)
  assert.ok(isStable('1.0.0+build.2'))
  assert.equal(compareVersions('1.0.0', '1.0.0+build.2'), 0, 'build 元数据不影响优先级')
  // build 元数据不参与比较：等值组内顺序稳定，组间仍按数值段比
  assert.equal(pickLatest(['1.0.0+build.2', '0.9.0']), '1.0.0+build.2')
  assert.equal(pickLatest(['0.9.0', '1.0.0+build.1']), '1.0.0+build.1')
})

test('compareVersions：预发布数字段按数值比较', () => {
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.9') > 0)
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0-alpha.2') > 0, '数字段低于字母段')
  assert.equal(pickLatest(['2.0.0-rc.9', '2.0.0-rc.10']), '2.0.0-rc.10')
})

test('compareVersions：相同前缀缺失段 < 有段（rc < rc.1）', () => {
  assert.ok(compareVersions('1.0.0-rc', '1.0.0-rc.1') < 0)
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0-rc') > 0)
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha') > 0)
  assert.equal(pickLatest(['2.0.0-rc', '2.0.0-rc.1']), '2.0.0-rc.1')
})

test('compareVersions：显式空段与缺失段严格区分（rc. > rc）', () => {
  assert.ok(compareVersions('1.0.0-rc.', '1.0.0-rc') > 0, '空段视为存在段，排在缺失段之后')
  assert.ok(compareVersions('1.0.0-rc', '1.0.0-rc.') < 0)
})

test('compareVersions：数值比较与预发布低于正式版', () => {
  assert.ok(compareVersions('5.1.0', '5.0.1') > 0)
  assert.ok(compareVersions('5.0.1', '5.1.0') < 0)
  assert.ok(compareVersions('5.0.0', '5.0.0-rc.1') > 0)
  assert.ok(compareVersions('4.21.2', '5.0.1') < 0)
  assert.equal(compareVersions('1.1.1', '1.1.1'), 0)
})

test('isStable：预发布不算稳定版', () => {
  assert.ok(isStable('5.1.0'))
  assert.ok(!isStable('5.0.0-rc.1'))
})

test('pickLatest：优先稳定版，忽略预发布', () => {
  assert.equal(pickLatest(VERSIONS), '5.1.0')
})

test('pickLatest：只有预发布时退回最新预发布', () => {
  assert.equal(pickLatest(['2.0.0-beta.1', '2.0.0-alpha.2']), '2.0.0-beta.1')
  assert.equal(pickLatest([]), null)
})

test('selectRelease：缺省/latest 取最新稳定版', () => {
  assert.deepEqual(selectRelease(null, VERSIONS), { version: '5.1.0', kind: 'latest', note: '取最新稳定版' })
  assert.deepEqual(selectRelease('latest', VERSIONS), { version: '5.1.0', kind: 'latest', note: '取最新稳定版' })
})

test('selectRelease：精确匹配', () => {
  assert.equal(selectRelease('4.21.2', VERSIONS).kind, 'exact')
  assert.equal(selectRelease('4.21.2', VERSIONS).version, '4.21.2')
  // v 前缀容错
  assert.equal(selectRelease('v4.21.2', VERSIONS).version, '4.21.2')
})

test('selectRelease：前缀匹配 5 → 最新 5.x；5.0 → 最新 5.0.x', () => {
  assert.equal(selectRelease('5', VERSIONS).version, '5.1.0')
  assert.equal(selectRelease('5.0', VERSIONS).version, '5.0.1')
  assert.equal(selectRelease('5.0.x', VERSIONS).version, '5.0.1')
  assert.equal(selectRelease('5.0.*', VERSIONS).version, '5.0.1')
  assert.equal(selectRelease('4', VERSIONS).version, '4.21.2')
})

test('selectRelease：大写 V 前缀容错（精确与前缀路径一致）', () => {
  assert.equal(selectRelease('V5.1.0', VERSIONS).version, '5.1.0')
  assert.equal(selectRelease('V5.1', VERSIONS).version, '5.1.0')
  assert.equal(selectRelease('v5.1.x', VERSIONS).version, '5.1.0')
})

test('selectRelease：无前缀命中时抛 VERSION 错误并带候选', () => {
  assert.throws(() => selectRelease('9', VERSIONS), (err) => {
    assert.equal(err.code, 'version')
    assert.match(err.message, /可用版本/)
    return true
  })
  assert.throws(() => selectRelease('5.2', VERSIONS))
})

test('selectRelease：空版本列表视为索引损坏', () => {
  assert.throws(() => selectRelease('latest', []), (err) => err.code === 'version')
})

test('版本边界：大写 X 模式、前导零前缀与不等长数值段', () => {
  // 大写 X 与 x/* 等价
  assert.equal(selectRelease('5.1.X', VERSIONS).version, '5.1.0')
  assert.equal(selectRelease('5.X', VERSIONS).version, '5.1.0')
  assert.equal(selectRelease('V5.1.*', VERSIONS).version, '5.1.0')
  // 前导零的精确串不在列表 → 走前缀路径（'04' → 4.x）
  assert.equal(selectRelease('04', VERSIONS).version, '4.21.2')
  assert.equal(selectRelease('04.20', VERSIONS).version, '4.20.0')
  // 数值段等值但长度不同视为同一版本
  assert.equal(compareVersions('5.1', '5.1.0'), 0)
  assert.equal(compareVersions('v5', '5.0.0'), 0)
  assert.deepEqual(parseVersion('v5').parts, [5])
  // 预发布与正式版之间取正式版；全部预发布时取最新预发布
  assert.equal(selectRelease('5.0', [...VERSIONS, '5.0.0-beta.2']).version, '5.0.1')
  assert.equal(pickLatest(['1.0.0-rc.1', '1.0.0-beta.1']), '1.0.0-rc.1')
})
