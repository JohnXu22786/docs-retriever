/**
 * 配置分层加载：命令行标志 > 环境变量 > 配置文件 > 默认值。
 * 配置文件为 JSON（路径由 --config 或 DOCTROVE_CONFIG 指定）。
 * 所有配置键均为只读参数，本插件不发起任何写操作。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DoctroveError, ErrorCodes } from './errors.js'

export const DEFAULT_CACHE_TTL_MS = 600_000   // 远程索引/查询结果缓存 10 分钟
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_RESULTS = 8

/** 内置本地索引的默认路径（相对本模块解析，与 cwd 无关） */
function defaultLocalIndexPath() {
  return fileURLToPath(new URL('../../data/index.json', import.meta.url))
}

const VALUE_FLAGS = new Set([
  'config',
  'index-url',
  'local-index',
  'cache-ttl',
  'timeout-ms',
])

const BOOL_FLAGS = new Set(['no-cache', 'debug', 'version', 'help'])

function parseBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

/**
 * 解析命令行参数，支持 `--flag value` 与 `--flag=value` 两种写法。
 * 返回 flag 名 → 值的映射。
 */
export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (VALUE_FLAGS.has(name)) {
      let value = eq === -1 ? undefined : arg.slice(eq + 1)
      if (value === undefined) {
        i += 1
        value = argv[i]
      }
      if (value === undefined || value === '') {
        throw new DoctroveError(`参数 --${name} 缺少取值`, { code: ErrorCodes.CONFIG })
      }
      flags[name] = value
    } else if (BOOL_FLAGS.has(name)) {
      if (eq !== -1) {
        throw new DoctroveError(`参数 --${name} 不接受取值`, { code: ErrorCodes.CONFIG })
      }
      flags[name] = true
    } else {
      throw new DoctroveError(`不支持的参数：--${name}`, { code: ErrorCodes.CONFIG })
    }
  }
  if (positional.length > 0) {
    throw new DoctroveError(`不支持的参数：${positional.join(' ')}`, { code: ErrorCodes.CONFIG })
  }
  return flags
}

function readConfigFile(path) {
  if (!path) return {}
  if (!existsSync(path)) {
    throw new DoctroveError(`配置文件不存在：${path}`, { code: ErrorCodes.CONFIG })
  }
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new DoctroveError(`无法读取配置文件 ${path}：${err.message}`, { code: ErrorCodes.CONFIG })
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层必须是对象')
    }
    return parsed
  } catch (err) {
    throw new DoctroveError(`配置文件 ${path} 不是合法的 JSON 对象：${err.message}`, { code: ErrorCodes.CONFIG })
  }
}

function normalizeUrl(value, flagName) {
  if (!value) return null
  const url = String(value).replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new DoctroveError(`参数 --${flagName} 不是合法的 URL：${value}`, { code: ErrorCodes.CONFIG })
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new DoctroveError(`参数 --${flagName} 仅支持 http/https 协议：${value}`, { code: ErrorCodes.CONFIG })
  }
  return url
}

/**
 * 取第一个「已设置」的值：null/undefined/空串视为未设置（继续回退）；
 * 数字 0 是合法值（如 cacheTtl: 0 表示关闭缓存），必须保留。
 */
function firstSet(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/**
 * 加载并合并配置。argv 不含 node/脚本自身。
 * env 仅用于读取 DOCTROVE_* 环境变量（便于测试注入）。
 */
export function loadConfig(argv, env) {
  const flags = parseArgs(argv ?? [])
  const envMap = env ?? process.env

  // 帮助/版本优先于配置文件读取：配置损坏时仍能自救
  if (flags.version) return { version: true, help: false }
  if (flags.help) return { help: true, version: false }

  const file = readConfigFile(flags.config ?? envMap.DOCTROVE_CONFIG)

  const indexUrl = firstSet(flags['index-url'], envMap.DOCTROVE_INDEX_URL, file.indexUrl) ?? null
  const localIndex = firstSet(flags['local-index'], envMap.DOCTROVE_LOCAL_INDEX, file.localIndex) ?? defaultLocalIndexPath()
  // 类型防线：数字/布尔等会被 fs 当作文件描述符（0 = stdin，会消费协议字节），必须拒绝
  if (typeof localIndex !== 'string' || localIndex === '') {
    throw new DoctroveError(
      `localIndex 必须是文件路径字符串（收到：${JSON.stringify(localIndex)}）`,
      { code: ErrorCodes.CONFIG },
    )
  }

  const rawTimeout = firstSet(flags['timeout-ms'], envMap.DOCTROVE_TIMEOUT_MS, file.timeoutMs) ?? DEFAULT_TIMEOUT_MS
  const timeoutMs = Number(rawTimeout)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new DoctroveError(
      `超时值非法：${rawTimeout}（应为 1–300000 毫秒的整数）`,
      { code: ErrorCodes.CONFIG },
    )
  }

  // cacheTtl 单位：秒。0 表示关闭缓存；--no-cache 是它的快捷方式。
  const rawTtl = firstSet(flags['cache-ttl'], envMap.DOCTROVE_CACHE_TTL, file.cacheTtl) ?? Math.floor(DEFAULT_CACHE_TTL_MS / 1000)
  const cacheTtlSec = Number(rawTtl)
  if (!Number.isInteger(cacheTtlSec) || cacheTtlSec < 0 || cacheTtlSec > 86_400) {
    throw new DoctroveError(
      `缓存 TTL 非法：${rawTtl}（应为 0–86400 秒的整数，0 表示关闭缓存）`,
      { code: ErrorCodes.CONFIG },
    )
  }

  const debug = flags.debug ?? (envMap.DOCTROVE_DEBUG !== undefined
    ? parseBool(envMap.DOCTROVE_DEBUG)
    : (file.debug ?? false))

  return {
    indexUrl: normalizeUrl(indexUrl, 'index-url'),
    localIndex,
    timeoutMs,
    cacheTtlMs: flags['no-cache'] ? 0 : cacheTtlSec * 1000,
    debug: Boolean(debug),
    help: false,
    version: false,
  }
}
