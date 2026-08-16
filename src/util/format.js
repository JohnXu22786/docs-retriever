/**
 * 输出格式化小工具。
 */

/** 稳定的 JSON 文本（不做缩进美化，节省协议字节） */
export function jsonText(value) {
  return JSON.stringify(value)
}
