/**
 * 检索评分单元测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, scoreEntry, rankEntries, rankSections } from '../src/catalog/scoring.js'

const EXPRESS = {
  id: 'express',
  name: 'Express',
  summary: 'Node.js 极简 Web 应用框架',
  aliases: ['expressjs'],
  popularity: 1200,
}

test('tokenize：英文按词、中文逐字、大小写归一', () => {
  assert.deepEqual(tokenize('Express Web App'), ['express', 'web', 'app'])
  assert.deepEqual(tokenize('日期处理'), ['日', '期', '处', '理'])
  assert.deepEqual(tokenize(''), [])
})

test('scoreEntry：名称精确匹配给 1.0 并带信号', () => {
  const { score, matches } = scoreEntry('Express', EXPRESS)
  assert.equal(score, 1.0)
  assert.ok(matches.includes('名称精确匹配'))
})

test('scoreEntry：别名精确匹配接近但低于精确匹配', () => {
  const { score, matches } = scoreEntry('expressjs', EXPRESS)
  assert.ok(score > 0.95 && score < 1.0, `别名分 ${score} 应在 (0.95, 1.0) 区间`)
  assert.ok(matches.includes('别名精确匹配'))
})

test('scoreEntry：流行度微调不反转信号层级', () => {
  // 高流行度的别名命中仍低于低流行度的名称精确命中
  const famousAlias = scoreEntry('expressjs', EXPRESS).score
  const obscureExact = scoreEntry('Express', { ...EXPRESS, popularity: 1 }).score
  assert.ok(famousAlias < obscureExact)
  // 流行度微调只影响同级信号
  const famous = scoreEntry('Express', { ...EXPRESS, popularity: 1e9 })
  const obscure = scoreEntry('Express', { ...EXPRESS, popularity: 1 })
  assert.equal(famous.score, 1.0)
  assert.equal(obscure.score, 1.0)
})

test('scoreEntry：词元重叠满命中也不可越过别名前缀层（层级间隙）', () => {
  // 名称满词元重叠（raw=0.83）+ 最大流行度微调，仍低于别名前缀（0.85）
  const tokenMax = scoreEntry('web express app', { ...EXPRESS, popularity: 1e9 }).score
  const aliasPrefix = scoreEntry('expressj', EXPRESS).score
  assert.ok(tokenMax < aliasPrefix, `词元重叠 ${tokenMax} 应低于别名前缀 ${aliasPrefix}`)
})

test('scoreEntry：0..1 归一化流行度不产生负微调', () => {
  const normalized = scoreEntry('expressjs', { ...EXPRESS, popularity: 0.5 }).score
  const unit = scoreEntry('expressjs', { ...EXPRESS, popularity: 1 }).score
  assert.equal(normalized, unit, 'popularity<1 不参与微调，分数与 popularity=1 一致')
})

test('scoreEntry：前缀匹配高于词元重叠', () => {
  const prefix = scoreEntry('expr', EXPRESS).score
  const tokenOverlap = scoreEntry('node web', EXPRESS).score
  assert.ok(prefix > tokenOverlap, `prefix=${prefix} 应大于 tokenOverlap=${tokenOverlap}`)
})

test('scoreEntry：摘要命中给分，且低于名称类命中', () => {
  const viaSummary = scoreEntry('框架', EXPRESS).score
  const viaName = scoreEntry('Express', EXPRESS).score
  assert.ok(viaSummary > 0)
  assert.ok(viaSummary < viaName)
})

test('scoreEntry：完全无关的查询得 0 分', () => {
  const { score } = scoreEntry('xyzqwerty', EXPRESS)
  assert.equal(score, 0)
})

test('rankEntries：按分降序、同分按流行度降序', () => {
  const entries = [
    { id: 'b', name: 'B', summary: 'x', popularity: 10 },
    { id: 'a', name: 'A', summary: 'x', popularity: 100 },
  ]
  const ranked = rankEntries('A', entries)
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].entry.id, 'a')
})

test('rankSections：空 focus 原序截断，score 记 0', () => {
  const sections = [{ heading: 'a' }, { heading: 'b' }, { heading: 'c' }]
  const out = rankSections('', sections, 2)
  assert.deepEqual(out.map((s) => s.heading), ['a', 'b'])
  assert.equal(out[0].score, 0)
})

test('rankSections：标题命中权重高于正文命中', () => {
  const sections = [
    { heading: '路由参数', body: 'express 的 req.params 用法' },
    { heading: '其他', body: '路由参数在 body 里提到' },
  ]
  const out = rankSections('路由参数', sections, 2)
  assert.equal(out[0].heading, '路由参数')
  assert.ok(out[0].score > out[1].score)
})

test('rankSections：无命中的片段被过滤，超出 max 被截断', () => {
  const sections = [
    { heading: '路由', body: 'app.get' },
    { heading: '中间件', body: 'app.use' },
    { heading: '模板', body: 'ejs' },
  ]
  const out = rankSections('模板 ejs', sections, 1)
  assert.equal(out.length, 1)
  assert.equal(out[0].heading, '模板')
})
