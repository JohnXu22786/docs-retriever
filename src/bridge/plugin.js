/**
 * dsh（DeepSeek Harness）接入插件：在 harness 进程内直接加载本 MCP server。
 *
 * 工作原理：本插件作为 Cordis 插件挂载在 dsh 中（需要 ctx.tools 服务），
 * 用 Node 自身作为运行时拉起重启本包内的 src/entry.js 子进程，
 * 通过 stdio 完成 MCP 握手，把全部工具注册进 ctx.tools，
 * 公共工具名为 mcp__<serverName>__<工具名>（如 mcp__doctrove__doc_extract）。
 *
 * 与官方桥接（@deepseek-ai/dsh-mcp-client 配置行）相比，
 * 本插件零外部依赖、开箱即用；两者可以在 cordis.patch.yml 中任选其一。
 *
 * 插件配置（cordis.patch.yml 的 config 键）：
 *   serverName: 命名空间，默认 doctrove
 *   args:       透传给 server 的启动参数，例如 ['--index-url', 'https://docs.example.com/index']
 *   env:        追加到子进程环境的变量，例如 { DOCTROVE_INDEX_URL: '...' }
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { StdioClient, publicToolName } from './client.js'

export const name = 'doctrove-bridge'
export const inject = ['tools']

const ENTRY_PATH = fileURLToPath(new URL('../entry.js', import.meta.url))

/** 把 MCP 结果渲染成给模型看的文本 */
function renderText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

export async function apply(ctx, config = {}) {
  const serverName = typeof config.serverName === 'string' && config.serverName
    ? config.serverName
    : 'doctrove'
  const args = Array.isArray(config.args) ? config.args : []
  const env = config.env && typeof config.env === 'object' && !Array.isArray(config.env)
    ? config.env
    : {}

  const child = spawn(process.execPath, [ENTRY_PATH, ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  })
  const client = new StdioClient({ child, log: (m) => console.error(`[${name}] ${m}`) })

  // 先注册清理效果：无论 apply 是否成功，卸载时都要断开子进程
  ctx.effect(() => () => client.dispose(), `${name}.connection`)

  let tools
  try {
    tools = await client.connect()
  } catch (err) {
    // 握手失败：显式清理子进程（不依赖框架对失败插件的隐式回收）
    client.dispose()
    throw err
  }
  for (const tool of tools) {
    ctx.tools.register({
      name: publicToolName(serverName, tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: value?.renderedText ?? JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const result = await client.call(tool.name, args ?? {}, exec?.signal)
        if (result.isError) {
          throw new Error(renderText(result.structuredContent?.error?.message ?? result.content))
        }
        // canonical value = 结构化数据；渲染文本并入 renderedText，
        // 避免 content 与 structuredContent 双重渲染
        return { ...result.structuredContent, renderedText: renderText(result.content) }
      },
    })
  }
  console.error(`[${name}] 已注册 ${tools.length} 个工具（serverName=${serverName}）`)
}
