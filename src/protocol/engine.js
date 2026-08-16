/**
 * MCP 会话引擎：把 MCP 方法调用翻译为工具注册表调用。
 * 协议细节：
 *  - initialize 协商协议版本：回显客户端支持的版本，否则给自身最新版；
 *  - tools/list 返回注册表全部工具声明；
 *  - tools/call 的工具级失败以 isError 结果返回（非 JSON-RPC 错误），
 *    未知工具/未知方法才是协议级错误；
 *  - 通知（无 id 的消息）不产生响应；
 *  - 未 initialize 就调用其他方法 → -32002（MCP 规范）。
 */
import { classify, createResponse, createError, ERROR_CODES } from './jsonrpc.js'
import { friendlyText } from '../core/errors.js'

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0]

/** 协议级：会话未初始化（MCP 规范 2025-06-18） */
export const ERROR_SERVER_NOT_INITIALIZED = -32002

export class McpEngine {
  /**
   * @param {object} opts
   * @param {import('../tools/registry.js').ToolRegistry} opts.registry
   * @param {object} opts.services 注入给工具执行的依赖（store/config/version）
   * @param {{name:string, version:string}} opts.serverInfo
   * @param {Function} [opts.log]
   */
  constructor({ registry, services, serverInfo, log = () => {} }) {
    this.registry = registry
    this.services = services
    this.serverInfo = serverInfo
    this.log = log
    this.initialized = false
  }

  /** 处理一条消息，返回要写回的消息；通知/响应返回 null */
  async handle(msg) {
    const kind = classify(msg)
    if (kind === 'invalid') {
      return createError(msg?.id ?? null, ERROR_CODES.INVALID_REQUEST, '无效的 JSON-RPC 消息')
    }
    if (kind === 'response') return null
    const { id, method, params } = msg
    if (kind === 'notification') {
      this.onNotification(method, params)
      return null
    }
    if (!this.initialized && method !== 'initialize') {
      return createError(id, ERROR_SERVER_NOT_INITIALIZED, '会话尚未初始化：请先发送 initialize 请求')
    }
    try {
      switch (method) {
        case 'initialize':
          return createResponse(id, this.onInitialize(params))
        case 'ping':
          return createResponse(id, {})
        case 'tools/list':
          return createResponse(id, { tools: this.registry.list() })
        case 'tools/call': {
          const name = params?.name
          if (typeof name !== 'string' || !this.registry.get(name)) {
            return createError(id, ERROR_CODES.INVALID_PARAMS, `未知工具：${name ?? '(未提供)'}`)
          }
          return createResponse(id, await this.onToolCall(params))
        }
        default:
          return createError(id, ERROR_CODES.METHOD_NOT_FOUND, `未知方法：${method}`)
      }
    } catch (err) {
      this.log(`处理 ${method} 失败：${friendlyText(err)}`)
      return createError(id, ERROR_CODES.INTERNAL_ERROR, '内部错误')
    }
  }

  onInitialize(params) {
    const requested = params?.protocolVersion
    const version = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION
    this.initialized = true
    return {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: this.serverInfo,
    }
  }

  onNotification(method) {
    if (method === 'notifications/initialized') this.log('客户端已完成初始化')
  }

  /** 执行工具调用；任何可预期失败都折叠为 isError 结果 */
  async onToolCall(params) {
    const { name, arguments: args } = params
    try {
      // 工具执行体直接返回 MCP 结果形态 { content, structuredContent }
      return await this.registry.call(name, args ?? {}, this.services)
    } catch (err) {
      // 刻意设计：参数校验失败也折叠为 isError（而非 -32602 协议错误），
      // 让模型能在一次调用里看到结构化错误码并自纠错（SEP-1319 方向）；
      // 未知工具/未知方法仍是协议级错误（见 handle 的 tools/call 分支）。
      const message = friendlyText(err)
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
        structuredContent: { error: { code: err?.code ?? 'internal', message } },
      }
    }
  }
}
