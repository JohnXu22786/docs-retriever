/**
 * JSON-RPC 2.0 消息编解码与分类（MCP 使用此协议，stdio 上按行分隔）。
 */

export const ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
})

/**
 * 判断消息类型：
 *  'request' | 'notification' | 'response' | 'invalid'
 */
export function classify(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'invalid'
  if (msg.jsonrpc !== '2.0') return 'invalid'
  const hasMethod = typeof msg.method === 'string'
  const hasId = 'id' in msg
  const hasResult = 'result' in msg
  const hasError = msg.error !== undefined && msg.error !== null
  // method 与 result/error 同时出现是冲突消息；result 与 error 同现也是冲突
  if (hasMethod && (hasResult || hasError)) return 'invalid'
  if (hasResult && hasError) return 'invalid'
  if (hasMethod) return hasId ? 'request' : 'notification'
  if (hasResult || hasError) return hasId ? 'response' : 'invalid'
  return 'invalid'
}

export function createResponse(id, result) {
  return { jsonrpc: '2.0', id, result }
}

export function createError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
