/**
 * 索引托管脚本端到端测试：启动 serve-index.mjs，验证 200/ETag/304、越界与 404。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/serve-index.mjs', import.meta.url))
const PORT = 18730
let child

before(async () => {
  child = spawn(process.execPath, [SCRIPT, 'data', String(PORT)], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  // 等待端口就绪
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/index.json`)
      if (res.status === 200) return
    } catch {
      /* 未就绪，继续等 */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('索引托管未能在 5 秒内就绪')
})

after(async () => {
  if (child && !child.killed) {
    const exited = new Promise((resolve) => child.on('exit', resolve))
    child.kill()
    // 等待子进程真正退出，避免孤儿进程占住端口导致后续运行连到旧实例
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  }
})

/** 原始 socket 请求：绕过 fetch 的 URL 规范化，用于测试目录穿越 */
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, '127.0.0.1')
    let data = ''
    sock.on('data', (chunk) => { data += chunk })
    sock.on('error', reject)
    sock.on('close', () => resolve(data))
    sock.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
  })
}

test('index.json 可访问且是合法索引', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/index.json`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /json/)
  assert.ok(res.headers.get('etag'))
  const index = await res.json()
  assert.equal(index.format, 'doctrove-index@1')
  assert.ok(index.entries.length >= 3)
})

test('ETag 条件请求返回 304', async () => {
  const first = await fetch(`http://127.0.0.1:${PORT}/index.json`)
  const etag = first.headers.get('etag')
  const second = await fetch(`http://127.0.0.1:${PORT}/index.json`, {
    headers: { 'if-none-match': etag },
  })
  assert.equal(second.status, 304)
})

test('目录穿越请求不泄露索引目录外的文件', async () => {
  // 路径在 normalize 阶段被折叠到索引目录内（或拒绝），
  // 因此 403/404 均可接受，但绝不能返回项目根的 package.json 内容
  const traversal = await rawGet('/../package.json')
  assert.match(traversal, / 40[34] /)
  assert.ok(!traversal.includes('doctrove'), '穿越请求不得返回索引目录外的文件内容')
  const missing = await fetch(`http://127.0.0.1:${PORT}/nope.json`)
  assert.equal(missing.status, 404)
})

test('畸形 % 编码请求返回 404 而非崩溃', async () => {
  const malformed = await rawGet('/%zz.json')
  assert.match(malformed, / 404 /)
})

test('symlink 指向根外文件：即使 ETag 命中也不得返回 304', async () => {
  // victim 放在索引目录之外，目录内只放指向它的符号链接
  const { symlinkSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const docDir = mkdtempSync(join(tmpdir(), 'doctrove-doc-'))
  const outsideDir = mkdtempSync(join(tmpdir(), 'doctrove-out-'))
  const victim = join(outsideDir, 'victim.json')
  writeFileSync(victim, JSON.stringify({ secret: true }))
  const linkPath = join(docDir, 'leak.json')
  try {
    symlinkSync(victim, linkPath)
  } catch {
    rmSync(docDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
    return // 平台不支持 symlink（如无权限），跳过
  }

  const victimStat = await import('node:fs/promises').then((m) => m.stat(victim))
  const etag = `"${victimStat.size.toString(16)}-${Math.floor(victimStat.mtimeMs).toString(16)}"`

  // 用独立端口起一个 docDir=该临时目录的托管实例
  const PORT2 = 18732
  const host2 = spawn(process.execPath, [SCRIPT, docDir, String(PORT2)], { stdio: ['ignore', 'ignore', 'inherit'] })
  try {
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT2}/leak.json`)
        if (res.status !== 404) break // 实例已就绪
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 100))
    }
    const res = await fetch(`http://127.0.0.1:${PORT2}/leak.json`, { headers: { 'if-none-match': etag } })
    assert.notEqual(res.status, 304, 'symlink 逃逸不得以 304 确认根外文件存在')
    assert.equal(res.status, 404)
  } finally {
    if (!host2.killed) host2.kill()
    await new Promise((r) => setTimeout(r, 300))
    rmSync(docDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  }
})
