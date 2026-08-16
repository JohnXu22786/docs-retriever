/**
 * 插件标识常量：名称、版本与 User-Agent。
 */
export const NAME = 'doctrove'
export const VERSION = '1.0.0'
export const PROTOCOL_NAME = 'mcp'

export function userAgent() {
  return `${NAME}/${VERSION} (${PROTOCOL_NAME}; node ${process.version})`
}
