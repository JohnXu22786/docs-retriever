#!/usr/bin/env node
/**
 * 入口：解析配置 → 装配数据源与目录 → 启动 stdio MCP 会话。
 * 可作为独立 MCP server 被任意客户端加载（命令：node src/entry.js）。
 */
import { loadConfig } from './core/config.js'
import { NAME, VERSION, userAgent } from './core/version.js'
import { TtlCache } from './vault/ttl.js'
import { LocalSource, RemoteSource } from './supply/provider.js'
import { CatalogStore } from './catalog/store.js'
import { buildRegistry } from './tools/definitions.js'
import { McpEngine } from './protocol/engine.js'
import { StdioLoop } from './protocol/transport.js'

const HELP = `${NAME} v${VERSION} —— 版本化库文档检索（MCP stdio server）

用法：
  node src/entry.js [选项]

选项：
  --config <path>        配置文件（JSON，键见 README）
  --index-url <url>      远程索引地址（插件按 <url>/index.json 拉取；不配则用本地索引）
  --local-index <path>   本地索引文件路径（默认内置 data/index.json）
  --cache-ttl <sec>      缓存存活秒数（0 关闭，默认 600；影响远程索引与查询结果）
  --no-cache             关闭缓存（等价 --cache-ttl 0）
  --timeout-ms <ms>      远程请求超时（1–300000，默认 15000）
  --debug                输出调试日志（stderr）
  --version              打印版本
  --help                 打印本帮助

环境变量：DOCTROVE_INDEX_URL、DOCTROVE_LOCAL_INDEX、DOCTROVE_CACHE_TTL、
DOCTROVE_TIMEOUT_MS、DOCTROVE_CONFIG、DOCTROVE_DEBUG。

协议：stdin/stdout 上的行分隔 JSON-RPC 2.0（MCP）。日志只写 stderr。
工具：catalog_lookup（检索目录）、catalog_releases（版本清单）、doc_extract（提取文档）。
离线模式：不配置 --index-url 即完全离线运行，使用内置本地索引。
`

function main() {
  const argv = process.argv.slice(2)
  let config
  try {
    config = loadConfig(argv)
  } catch (err) {
    process.stderr.write(`[${NAME}] 配置错误：${err.message}\n`)
    process.exit(2)
  }
  if (config.help) {
    process.stdout.write(HELP)
    process.exitCode = 0
    return // 让 stdout 自然排空后再退出，避免管道场景截断
  }
  if (config.version) {
    process.stdout.write(`${NAME} ${VERSION}\n`)
    process.exitCode = 0
    return
  }

  const log = (...parts) => {
    if (config.debug) process.stderr.write(`[${NAME}] ${parts.join(' ')}\n`)
  }

  const cache = new TtlCache({ ttlMs: config.cacheTtlMs })
  const sources = []
  if (config.indexUrl) {
    sources.push(new RemoteSource({
      baseUrl: config.indexUrl,
      cache,
      timeoutMs: config.timeoutMs,
      userAgent: userAgent(),
      log,
    }))
  }
  sources.push(new LocalSource({ path: config.localIndex, log }))
  const store = new CatalogStore({ sources, log })
  const services = { store, config, version: { name: NAME, version: VERSION } }
  const registry = buildRegistry(services)
  const engine = new McpEngine({
    registry,
    services,
    serverInfo: { name: NAME, version: VERSION },
    log,
  })

  process.stderr.write(
    `[${NAME}] v${VERSION} 已启动（索引=${config.indexUrl ? `远程 ${config.indexUrl} + 本地兜底` : '本地（离线）'}，` +
    `缓存=${config.cacheTtlMs > 0 ? `${config.cacheTtlMs}ms` : '关闭'}，工具=${registry.list().length} 个）\n`,
  )
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[${NAME}] 未捕获异常，进程退出：${err?.stack ?? err}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[${NAME}] 未处理的 Promise 拒绝：${err?.stack ?? err}\n`)
  })
  // 客户端断开后 stdout 管道消失：安静退出，避免 EPIPE 刷屏
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0)
  })
  process.stderr.on('error', () => { /* 忽略 stderr 管道错误 */ })
  // debug 模式：退出前输出缓存统计
  process.on('exit', () => {
    if (config.debug) log('缓存统计', JSON.stringify(cache.stats()))
  })

  const loop = new StdioLoop({ handle: (msg) => engine.handle(msg), log })
  loop.start()
}

main()
