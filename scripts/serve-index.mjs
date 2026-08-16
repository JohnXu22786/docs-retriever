#!/usr/bin/env node
/**
 * doctrove 索引托管脚本：把本地索引目录通过 HTTP 暴露给 RemoteSource。
 * 零依赖（仅 Node 内置 http/fs），支持 ETag 条件请求，便于配合缓存策略。
 *
 * 用法：
 *   node scripts/serve-index.mjs [目录] [端口]
 *   （默认目录 ./data，默认端口 8730）
 *
 * 然后以远程源方式启动 doctrove（--index-url 传目录根，插件按 <url>/index.json 拉取）：
 *   node src/entry.js --index-url http://localhost:8730
 */
import { createServer } from 'node:http'
import { readFile, stat, realpath } from 'node:fs/promises'
import { join, resolve, extname, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url))) // 包根
const dirArg = process.argv[2]
const portArg = process.argv[3]

const docDir = dirArg ? resolve(process.cwd(), dirArg) : join(root, 'data')
const port = Number(portArg ?? 8730)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`端口非法：${process.argv[3]}`)
  process.exit(2)
}

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

/**
 * 把请求路径安全地映射到 docDir 下。
 * normalize 会把越过根目录的 ".." 折叠掉（win32 与 POSIX 一致），
 * 此处 resolve 后的前缀检查是第二道防线：任何越界结果都返回 null。
 */
function safeJoin(base, rel) {
  const target = resolve(base, '.' + rel)
  if (target === base) return null
  return target.startsWith(base + sep) ? target : null
}

/** realpath 基准：与文件侧同样解析符号链接，避免「根目录是 symlink 时全部 404」 */
const docDirReal = await realpath(docDir).catch((err) => {
  console.error(`索引目录不可访问：${err.message}`)
  process.exit(1)
})

const server = createServer(async (req, res) => {
  try {
    // 直接用原始 req.url：new URL() 会把 /../ 规范化掉，导致穿越检测失效
    let pathname = decodeURIComponent(String(req.url ?? '/').split('?')[0])
    if (pathname === '/') pathname = '/index.json'

    const file = safeJoin(docDir, normalize(pathname))
    if (!file) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }

    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')

    // symlink 二次防线：真实路径必须仍在索引目录内（win32 上大小写归一后比较）。
    // 必须在 etag/304 快路径之前：etag 由跟随 symlink 的目标文件计算，
    // 若 304 先返回，等于向客户端确认了「根外文件存在且内容未变」。
    const real = await realpath(file)
    const cmpReal = process.platform === 'win32' ? real.toLowerCase() : real
    const cmpRoot = (process.platform === 'win32' ? docDirReal.toLowerCase() : docDirReal) + sep
    if (!cmpReal.startsWith(cmpRoot)) throw new Error('out of root')

    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'public, max-age=3600' })
      res.end()
      return
    }

    // 304/HEAD 之后才读 body，条件请求与 HEAD 不做无谓的整文件 IO
    const body = await readFile(file)

    const headers = {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=3600',
      etag,
      'access-control-allow-origin': '*',
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      res.end()
      return
    }
    res.writeHead(200, headers)
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
})

server.on('error', (err) => {
  console.error(`索引托管启动失败：${err.message}`)
  process.exit(1)
})

// 默认只监听本机回环；如要暴露到局域网，可自行把 host 改为 '0.0.0.0'
server.listen(port, '127.0.0.1', () => {
  console.error(`doctrove 索引托管：http://127.0.0.1:${port}/index.json（目录：${docDir}）`)
})
