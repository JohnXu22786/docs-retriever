/**
 * 工具注册表：工具声明、参数校验与分派。
 * 每个工具声明形如：
 *   { name, description, mutating, inputSchema, execute(args, services) }
 */
import { DoctroveError, ErrorCodes } from '../core/errors.js'

export class ToolRegistry {
  constructor() {
    this.defs = new Map()
  }

  register(def) {
    if (this.defs.has(def.name)) {
      throw new DoctroveError(`工具重复注册：${def.name}`, { code: ErrorCodes.CONFIG })
    }
    this.defs.set(def.name, def)
  }

  get(name) {
    return this.defs.get(name)
  }

  /** 模型可见的工具清单（MCP tools/list 的载荷） */
  list() {
    return [...this.defs.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }))
  }

  /**
   * 执行工具：校验参数 → 调用执行体。
   * @param {string} name 工具名
   * @param {unknown} rawArgs 模型传来的原始参数
   * @param {object} services 注入依赖（store / config / version）
   */
  async call(name, rawArgs, services) {
    const def = this.defs.get(name)
    if (!def) {
      throw new DoctroveError(`未知工具：${name}`, { code: ErrorCodes.VALIDATION })
    }
    const args = validateArgs(rawArgs, def.inputSchema, name)
    return def.execute(args, services)
  }
}

/**
 * 按 JSON Schema 子集校验参数：
 * 支持 type（string/number/integer/boolean/array/object）、
 * enum、minimum/maximum、array items。未知键忽略。
 */
export function validateArgs(raw, schema, toolName) {
  if (raw === null || raw === undefined) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DoctroveError(`工具 ${toolName} 的参数必须是对象`, { code: ErrorCodes.VALIDATION })
  }
  const props = schema.properties ?? {}
  for (const key of schema.required ?? []) {
    const value = raw[key]
    if (value === undefined || value === null) {
      throw new DoctroveError(`工具 ${toolName} 缺少必填参数 "${key}"`, { code: ErrorCodes.VALIDATION })
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    // 显式 null/undefined 视为未传（可选参数），required 检查已单独处理缺失
    if (value === null || value === undefined) continue
    const spec = props[key]
    if (spec) checkValue(value, spec, `${toolName}.${key}`)
  }
  return raw
}

function fail(where, detail) {
  throw new DoctroveError(`参数不合法：${where} ${detail}`, { code: ErrorCodes.VALIDATION })
}

function checkValue(value, spec, where) {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') {
        fail(where, '必须是字符串')
      } else if (spec.minLength !== undefined && value.length < spec.minLength) {
        fail(where, `长度不能少于 ${spec.minLength}`)
      }
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, '必须是有限数字')
      break
    case 'integer':
      if (!Number.isInteger(value)) fail(where, '必须是整数')
      break
    case 'boolean':
      if (typeof value !== 'boolean') fail(where, '必须是布尔值')
      break
    case 'array':
      if (!Array.isArray(value)) {
        fail(where, '必须是数组')
      } else if (spec.items) {
        for (const item of value) checkValue(item, spec.items, `${where}[]`)
      }
      break
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(where, '必须是对象')
      break
    default:
      break
  }
  if (spec.enum && !spec.enum.includes(value)) {
    fail(where, `只能是：${spec.enum.join(' / ')}`)
  }
  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) fail(where, `不能小于 ${spec.minimum}`)
    if (spec.maximum !== undefined && value > spec.maximum) fail(where, `不能大于 ${spec.maximum}`)
  }
}
