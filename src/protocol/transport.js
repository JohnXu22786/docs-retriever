/**
 * stdio 传输层：逐行读取 stdin（每行一条 JSON-RPC 消息），
 * 响应按行写回 stdout。所有日志一律走 stderr，绝不污染协议通道。
 *
 * 退出语义：输入流关闭后不立即强杀，而是等待在途请求完成、
 * 且最后一个响应真正排空到 stdout 后再退出（POSIX 管道写是异步的，
 * 直接 process.exit 会丢掉写队列里尚未送达的响应）。
 */
import { createInterface } from 'node:readline'
import { createError, ERROR_CODES } from './jsonrpc.js'

const FORCE_EXIT_AFTER_MS = 10_000
const FLUSH_TIMEOUT_MS = 2_000

export class StdioLoop {
  /**
   * @param {object} opts
   * @param {(msg: object) => (object|Promise<object|null>|null)} opts.handle 处理单条消息
   * @param {Function} [opts.log]
   */
  constructor({ handle, log = () => {} }) {
    this.handle = handle
    this.log = log
    this.inflight = 0
    this.closing = false
    this.exitTimer = null
  }

  start() {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let msg
      try {
        msg = JSON.parse(trimmed)
      } catch {
        this.write(createError(null, ERROR_CODES.PARSE_ERROR, '无法解析 JSON 消息'))
        return
      }
      let reply
      try {
        reply = this.handle(msg)
      } catch (err) {
        this.log(`消息处理异常：${err?.message ?? err}`)
        reply = createError(msg?.id ?? null, ERROR_CODES.INTERNAL_ERROR, '内部错误')
      }
      if (reply && typeof reply.then === 'function') {
        this.inflight += 1
        reply.then((resolved) => {
          if (resolved) {
            this.write(resolved, () => this.settle())
          } else {
            this.settle()
          }
        }).catch((err) => {
          this.log(`异步处理失败：${err?.message ?? err}`)
          this.write(createError(msg?.id ?? null, ERROR_CODES.INTERNAL_ERROR, '内部错误'), () => this.settle())
        })
      } else if (reply) {
        this.write(reply)
      }
    })
    rl.on('close', () => this.beginShutdown())
  }

  /** 一条异步消息的响应已排空；若正在收尾且无在途请求，则退出 */
  settle() {
    this.inflight = Math.max(0, this.inflight - 1)
    if (this.closing && this.inflight === 0) {
      this.exitGracefully()
    }
  }

  /** 输入流关闭：等待在途请求排空（上限 10 秒），随后退出 */
  beginShutdown() {
    this.log('输入流已关闭，等待在途请求完成…')
    this.closing = true
    if (this.inflight === 0) {
      this.exitGracefully()
      return
    }
    this.exitTimer = setTimeout(() => {
      this.log(`等待超时（仍有 ${this.inflight} 个在途请求），强制退出`)
      process.exit(0)
    }, FORCE_EXIT_AFTER_MS)
    this.exitTimer.unref()
  }

  /** 等 stdout 排空再退出，避免丢弃最后的响应 */
  exitGracefully() {
    if (process.stdout.writableLength === 0) {
      process.exit(0)
      return
    }
    const fallback = setTimeout(() => process.exit(0), FLUSH_TIMEOUT_MS)
    fallback.unref()
    process.stdout.once('drain', () => {
      clearTimeout(fallback)
      process.exit(0)
    })
  }

  write(msg, onFlush) {
    process.stdout.write(`${JSON.stringify(msg)}\n`, onFlush)
  }
}
