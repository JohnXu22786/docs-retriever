/**
 * 版本选择：把「请求串 + 可用版本列表」解析为一个确定版本。
 *
 * 支持的选择方式（按优先级）：
 *  - latest / 缺省  → 最新稳定版（无稳定版则取最新预发布版）
 *  - 精确匹配       → 唯一命中
 *  - 前缀匹配       → '5' 取最新 5.x，'5.1' 取最新 5.1.x，'5.1.x' 等价
 * 语义比较：数字段按数值、预发布版（-alpha 等）低于正式版。
 */
import { DoctroveError, ErrorCodes } from '../core/errors.js'

/** 解析版本为 { parts: number[], pre: string|null }；build 元数据（+build.2）被忽略，不计入 pre */
export function parseVersion(raw) {
  const text = String(raw ?? '').trim()
  const match = text.match(/^v?(\d+(?:\.\d+)*)(?:-([0-9a-zA-Z.-]+))?(?:\+([0-9a-zA-Z.-]+))?$/)
  if (!match) return { parts: [], pre: text === '' ? null : text, raw: text }
  const parts = match[1].split('.').map((n) => Number(n))
  const pre = match[2] ?? null
  return { parts, pre, raw: text }
}

/** 语义比较：返回负数/零/正数 */
export function compareVersions(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  const len = Math.max(va.parts.length, vb.parts.length)
  for (let i = 0; i < len; i += 1) {
    const x = va.parts[i] ?? 0
    const y = vb.parts[i] ?? 0
    if (x !== y) return x - y
  }
  // 相同数字段：无预发布 > 有预发布
  if (va.pre === vb.pre) return 0
  if (va.pre === null) return 1
  if (vb.pre === null) return -1
  return comparePre(va.pre, vb.pre)
}

/**
 * 预发布标识符比较（semver 规则）：按点分段；数字段按数值、且低于字母段；
 * 相同前缀时缺失段 < 有段（rc < rc.1）；显式空段（如 "rc."）视为存在段，
 * 排在有段之后、但与缺失段严格区分。
 */
function comparePre(a, b) {
  const as = a.split('.')
  const bs = b.split('.')
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i += 1) {
    const aMissing = i >= as.length
    const bMissing = i >= bs.length
    if (aMissing && bMissing) return 0
    if (aMissing) return -1 // 缺失段 < 有段
    if (bMissing) return 1
    const x = as[i]
    const y = bs[i]
    if (x === y) continue
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) return Number(x) - Number(y)
    if (xNumeric) return -1 // 数字段 < 字母段
    if (yNumeric) return 1
    return x < y ? -1 : 1
  }
  return 0
}

export function isStable(version) {
  return parseVersion(version).pre === null
}

/** 从列表中取最新版（稳定版优先；无稳定版时退回最新预发布版） */
export function pickLatest(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null
  const stable = versions.filter(isStable)
  const pool = stable.length > 0 ? stable : versions
  return [...pool].sort(compareVersions).at(-1)
}

/** 请求串是否形如 '5.x' / '5.1.x' / '5.*'（大小写不敏感的 v 前缀） */
function isXPattern(requested) {
  return /^(v?\d+(?:\.\d+)*)\.(?:x|\*)$/i.test(requested)
}

/** 请求串是否为纯数字段前缀（'5' / '5.1'），且在版本列表中存在同前缀成员 */
function matchPrefix(requested, versions) {
  const target = parseVersion(requested)
  if (target.parts.length === 0 || target.pre !== null) return null
  const pool = versions.filter((v) => {
    const vp = parseVersion(v)
    if (vp.parts.length < target.parts.length) return false
    return target.parts.every((n, i) => vp.parts[i] === n)
  })
  if (pool.length === 0) return null
  return pickLatest(pool)
}

/**
 * 解析请求版本。
 * @param {string|null|undefined} requested 请求串（null/''/'latest' 表示最新）
 * @param {string[]} versions 可用版本
 * @returns {{ version: string, kind: 'latest'|'exact'|'prefix', note: string }}
 * @throws {DoctroveError} 找不到匹配版本时抛出（code: VERSION，附候选列表）
 */
export function selectRelease(requested, versions) {
  const list = Array.isArray(versions) ? [...versions] : []
  if (list.length === 0) {
    throw new DoctroveError('该条目的版本列表为空，索引可能已损坏', { code: ErrorCodes.VERSION })
  }
  const query = String(requested ?? '').trim()

  if (query === '' || query === 'latest') {
    const version = pickLatest(list)
    const hasStable = list.some(isStable)
    return {
      version,
      kind: 'latest',
      note: hasStable ? '取最新稳定版' : '没有稳定版，取最新预发布版',
    }
  }

  // 统一去掉 v/V 前缀后再做精确与前缀匹配（parseVersion 仅容忍小写 v）
  const cleaned = query.replace(/^[vV](?=\d)/, '')
  if (list.includes(cleaned)) {
    return { version: cleaned, kind: 'exact', note: '精确匹配' }
  }

  const prefixQuery = isXPattern(cleaned) ? cleaned.replace(/\.(?:x|\*)$/i, '') : cleaned
  const prefixed = matchPrefix(prefixQuery, list)
  if (prefixed) {
    return {
      version: prefixed,
      kind: 'prefix',
      note: `前缀匹配 ${prefixQuery}.x → 最新 ${prefixQuery}.x 版本`,
    }
  }

  const alternatives = list.slice(0, 8).join(', ')
  const hint = list[0]?.split('.').slice(0, 2).join('.')
  throw new DoctroveError(
    `版本 "${query}" 不可用。该条目可用版本（前 ${Math.min(8, list.length)} 个）：${alternatives}。` +
      `可改用 "latest"、精确版本号或前缀（如 "${hint}"）。`,
    { code: ErrorCodes.VERSION },
  )
}
