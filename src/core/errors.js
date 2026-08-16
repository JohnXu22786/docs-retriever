/**
 * 统一错误模型：所有可预期失败都以 DoctroveError 抛出，
 * code 用于结构化识别，message 面向模型/用户给出可执行的提示。
 */

export const ErrorCodes = Object.freeze({
  CONFIG: 'config',         // 配置问题（缺失、非法、冲突）
  VALIDATION: 'validation', // 参数校验失败
  NOT_FOUND: 'not-found',   // 目录中不存在该条目
  VERSION: 'version',       // 请求的版本不可用
  NETWORK: 'network',       // 网络层失败（远程索引拉取失败等）
  TIMEOUT: 'timeout',       // 请求超时
  JSONRPC: 'jsonrpc',       // 对端协议错误
  INTERNAL: 'internal',     // 内部错误
})

export class DoctroveError extends Error {
  constructor(message, { code = ErrorCodes.INTERNAL, cause = null } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'DoctroveError'
    this.code = code
  }
}

/** 把任意异常渲染成给模型看的文本（绝不抛出） */
export function friendlyText(err) {
  if (err instanceof DoctroveError) {
    return `[${err.code}] ${err.message}`
  }
  const detail = err?.message ?? String(err)
  return `[internal] ${detail}`
}
