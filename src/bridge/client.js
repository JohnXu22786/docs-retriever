/**
 * MCP stdio 客户端：与 doctrove server 进程对话（行分隔 JSON-RPC 2.0）。
 * 供 dsh bridge 插件使用，也可独立用于任意 MCP server。
 */
import { DoctroveError, ErrorCodes } from '../core/errors.js'

/** dsh 风格的工具公共名：mcp__<serverName>__<原始名> */
export function publicToolName(serverName, rawName) {
  return `mcp__${serverName}__${rawName}`
}

export class StdioClient {
  /**
   * @param {object} opts
   * @param {import('node:child_process').ChildProcess} opts.child 已用 stdio 管道启动的子进程
   * @param {Function} [opts.log]
   * @param {number} [opts.handshakeTimeoutMs] 握手（initialize/tools/list）超时，防止“活而不响应”的子进程挂死启动
   */
  constructor({ child, log = () => {}, handshakeTimeoutMs = 15_000 }) {
    this.child = child
    this.log = log
    this.handshakeTimeoutMs = handshakeTimeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.disposed = false
    this.failed = false
    this.connected = false
    this.tools = []
    this._wireChild()
  }

  _wireChild() {
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk
      let idx
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (line) this._onLine(line)
      }
    })
    const failFast = (reason) => {
      this.failed = true
      this._rejectAll(new DoctroveError(reason, { code: ErrorCodes.NETWORK }))
    }
    this.child.on('error', (err) => {
      this.log(`子进程错误：${err.message}`)
      failFast(`子进程无法启动：${err.message}`)
    })
    this.child.on('exit', (code, signal) => {
      this.log(`子进程退出（code=${code} signal=${signal}）`)
      failFast(`子进程已退出（code=${code ?? signal ?? '未知'}），server 已断开`)
    })
    this.child.stdin.on('error', (err) => {
      this.log(`stdin 管道错误：${err.message}`)
      failFast(`与 server 的通信管道已断开：${err.message}`)
    })
  }

  _onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      this.log(`收到无法解析的行：${line.slice(0, 120)}`)
      return
    }
    if (!msg || typeof msg !== 'object' || !('id' in msg)) return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    if (msg.error) {
      entry.reject(new DoctroveError(`[${msg.error.code}] ${msg.error.message}`, { code: ErrorCodes.JSONRPC }))
    } else {
      entry.resolve(msg.result)
    }
  }

  _rejectAll(err) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.signal?.removeEventListener('abort', entry.onAbort)
      entry.reject(err)
    }
  }

  _send(message) {
    if (this.disposed || this.failed) {
      throw new DoctroveError('客户端已关闭', { code: ErrorCodes.NETWORK })
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params, signal) {
    return new Promise((resolve, reject) => {
      const id = this.nextId
      this.nextId += 1
      const entry = { resolve, reject, signal }
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        entry.onAbort = () => {
          this.pending.delete(id)
          reject(new DOMException('aborted', 'AbortError'))
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.pending.set(id, entry)
      try {
        this._send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
      } catch (err) {
        this.pending.delete(id)
        if (entry.onAbort) signal?.removeEventListener('abort', entry.onAbort)
        reject(err)
      }
    })
  }

  /** 建立会话：initialize → tools/list → initialized 通知；整体限时，失败即报 timeout */
  async connect() {
    const signal = AbortSignal.timeout(this.handshakeTimeoutMs)
    try {
      await this.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'doctrove-bridge', version: '1.0.0' },
      }, signal)
      const listed = await this.request('tools/list', {}, signal)
      this.tools = listed.tools ?? []
      this.connected = true
      this._send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      return this.tools
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new DoctroveError(
          `与 server 握手超时（${this.handshakeTimeoutMs}ms），子进程可能未能正常启动`,
          { code: ErrorCodes.TIMEOUT },
        )
      }
      throw err
    }
  }

  /**
   * 调用工具，返回 MCP 结果对象（{ content, structuredContent, isError? }）。
   * @param {string} rawName 工具原始名
   * @param {object} args 参数
   * @param {AbortSignal} [signal] 外部取消信号（dsh 场景由 exec.signal 提供）
   * @param {number} [timeoutMs] 未提供 signal 时的兜底超时，默认 60s
   */
  async call(rawName, args, signal, timeoutMs = 60_000) {
    const s = signal ?? AbortSignal.timeout(timeoutMs)
    return this.request('tools/call', { name: rawName, arguments: args ?? {} }, s)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this._rejectAll(new DoctroveError('客户端已关闭', { code: ErrorCodes.NETWORK }))
    if (!this.child.killed) this.child.kill()
  }
}
