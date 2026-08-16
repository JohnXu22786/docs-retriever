# doctrove — 版本化库文档检索（agent 工具集）

`doctrove` 是一个面向编码 agent 的**版本化文档检索**插件：它维护一份「库文档目录索引」，
让 agent 在写代码时**按需拉取准确、带版本、可溯源**的 API 文档片段，
而不是凭训练记忆猜测 API 用法——从而避免「文档里没有的 API」「过时的签名」「臆造的参数」。

- **零运行时依赖**：只用 Node.js 自带能力（`fetch`、`node:test`），无需安装任何包即可运行；
- **标准 MCP stdio server**：任何支持 MCP 的客户端（dsh、Claude Code、Codex、opencode 等）都能接入；
- **为 dsh 而生**：自带 dsh bundle（`cordis.patch.yml` + 自研桥接插件），`dsh plugin add` 一步接入，
  工具自动出现在模型工具列表里（`mcp__doctrove__*`）；
- **版本化**：每个条目带多版本文档卷，支持「最新稳定版 / 精确版本 / 前缀版本（`4` → 4.21.x）」选择；
- **结果评分排序**：条目检索与文档片段都带 0–1 相关度评分与命中信号，模型可核查「为什么排前面」；
- **离线可用**：内置本地示范索引（`data/index.json`），不联网、不配远程源即可运行；
- **远程索引可自建**：索引是开放 JSON 格式，可架设在任意静态托管上（附零依赖托管脚本）；
- **智能缓存**：TTL + LRU 内存缓存，远程索引与查询结果按配置自动失效，`--no-cache` 一键关闭；
- **降级容错**：远程索引不可达时自动回退到本地索引，结果带 `source` 标注，agent 可感知数据来源。

---

## 快速开始

### 方式 A：任意 MCP 客户端直接连接

```bash
# 需要 Node.js ≥ 18.17；不配任何参数即为离线模式（内置索引）
node src/entry.js
```

以 dsh 官方桥接为例的配置行（也适用于 Claude Code / Codex 的 MCP 配置）：

```yaml
# dsh：插入到 $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: mcp-doctrove
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: doctrove
        transport: stdio
        command: node
        args: ['/绝对路径/src/entry.js']
```

连接后模型即可看到 3 个工具：`catalog_lookup`、`catalog_releases`、`doc_extract`
（通用 MCP 客户端看到的是裸名；dsh 场景下带 `mcp__doctrove__` 前缀，见下）。

### 方式 B：作为 dsh 插件 bundle 安装（推荐）

本插件已声明为 dsh bundle（`package.json` 的 `dsh.bundle` 字段）。在插件 checkout 目录执行：

```bash
dsh plugin --profile web add .
```

- 首次使用会自动初始化 `web` profile，并把本包加入 `dsh.profile.bundles`；
- 包内 `cordis.patch.yml` 定义的 `doctrove/bridge` 插件会在 dsh 进程内直接拉起本 MCP server，
  完成握手后把全部工具注册进 `ctx.tools`，**无需手动改任何配置**；
- 离线可用：默认加载内置索引；需要远程索引时在 bridge 行配置 `args: ['--index-url', ...]`（见下）；
- 卸载：`dsh plugin --profile web remove doctrove`。

安装后重启 dsh，在会话中即可直接说：

> “用 Express 5 写一个带 `:id` 路由参数和 JSON 响应的接口，先查一下路由参数的准确写法”

对应工具调用链：`mcp__doctrove__catalog_lookup`（确认 express）→
`mcp__doctrove__doc_extract`（id=express，focus=路由参数）。

> 备注：dsh 默认不启用任何 MCP 服务器（每条 server 命令都是在沙箱之外执行的受信代码），
> 本插件的 bundle 行即“启用”动作本身；请只安装可信的插件。

---

## dsh 接入说明（插件化 harness 如何加载它）

dsh 使用 Cordis 插件框架，组合单元是 **bundle**：一个 npm 包 + 一份 patch 层。加载链条如下：

```
package.json（dsh.bundle.patch → ./cordis.patch.yml）
  └─ cordis.patch.yml 中的一行：name: 'doctrove/bridge'
       └─ src/bridge/plugin.js（Cordis 插件，inject: ['tools']）
            ├─ 用 Node 自身 spawn 出 src/entry.js（MCP server 子进程，stdio）
            ├─ 完成 initialize / tools/list 握手
            └─ 每个工具以 mcp__doctrove__<工具名> 注册进 ctx.tools
```

- **工具接口**：模型可见的工具名 = `mcp__<serverName>__<原始工具名>`，`serverName` 默认 `doctrove`；
- **事件/技能**：本插件不注册事件或技能，只通过 `ctx.tools` 工具接口暴露能力（只读工具，无副作用）；
- **生命周期**：插件 `apply` 期间完成握手与注册，卸载时自动杀掉子进程并注销全部工具
  （通过 `ctx.effect` 注册清理，热重载/卸载都不会残留）；
- **两种桥接可选**：bundle 内置的自研桥接 `doctrove/bridge`（零依赖、开箱即用）与
  dsh 官方 `@deepseek-ai/dsh-mcp-client` 配置行（见 `examples/overlay-for-dsh.yml.example`），
  工具命名与行为一致，任选其一，不要同时启用；
- **环境变量**：dsh 会从 MCP 子进程环境过滤凭据类变量；自研桥接的子进程继承宿主环境，
  `DOCTROVE_INDEX_URL` 等会透传，也可在 bridge 行用 `env:` 显式指定。

### 常见 dsh 问题

| 现象 | 处理 |
| --- | --- |
| 工具没出现在列表 | 检查 `cordis.patch.yml` 行是否生效（`dsh --profile <name> --dump-config` 看层），确认启动日志无报错 |
| 想要远程索引 | bridge 行配置 `args: ['--index-url', 'https://你的索引地址']`（目录根），或 `env: { DOCTROVE_INDEX_URL: '...' }` |
| 想要更宽松的缓存 | bridge 行配置 `args: ['--cache-ttl', '3600']`；测试/调试用 `--no-cache` |
| pnpm ≥10 拒绝 git 安装的 prepare 脚本 | 本插件是纯 JS、无构建脚本，不涉及；从 checkout 或 tarball 安装即可 |

---

## 工具清单（3 个，全部只读）

| 工具 | 作用 | 主要参数 |
| --- | --- | --- |
| `catalog_lookup` | 按名称/描述检索文档目录，返回带评分与命中信号的候选 | `query`（必填）、`limit` |
| `catalog_releases` | 列出条目的可用版本与推荐版本 | `id`（必填） |
| `doc_extract` | 提取指定条目/版本/聚焦点的文档片段（相关度排序） | `id`（必填）、`version`、`focus`、`maxSections` |

### catalog_lookup

检索文档目录。当不确定库的规范 id 时先调用它，再用返回的 `id` 调用 `doc_extract`。

```jsonc
// 请求
{ "query": "express", "limit": 5 }
// 响应（structuredContent 摘要）
{
  "results": [{
    "id": "express", "name": "Express", "summary": "Node.js 极简 Web 应用框架",
    "score": 1.0, "matches": ["名称精确匹配"],
    "versions": ["5.1.0", "4.21.2"], "latest": "5.1.0", "source": "local:.../data/index.json"
  }],
  "total": 1, "sources": ["local:.../data/index.json"]
}
```

### catalog_releases

查看条目的版本清单与推荐版本，便于确定目标版本是否可用（`doc_extract` 支持同样的版本语法）。

```jsonc
{ "id": "express" }
// → { "id": "express", "name": "Express", "latest": "5.1.0",
//     "versions": ["5.1.0", "4.21.2"], "source": "local:..." }
```

### doc_extract

提取文档。`focus` 一次只描述一个概念（如「路由参数」），跨概念的问题分多次调用，
避免结果被稀释；`version` 缺省取最新稳定版。

```jsonc
{ "id": "express", "version": "5", "focus": "通配符" }
// → {
//     "id": "express", "name": "Express", "version": "5.1.0",
//     "releaseKind": "prefix", "releaseNote": "前缀匹配 5.x → 最新 5.x 版本",
//     "sections": [{ "heading": "通配符路由", "score": 0.5, "matches": ["标题命中 1 词"], ... }],
//     "source": "local:..."
//   }
```

错误均为结构化 `isError` 结果，`error.code` 取值：`validation` / `not-found` / `version` /
`network` / `timeout` / `internal`，`message` 附中文修复指引（如版本不可用时列出候选）。
参数校验失败同样折叠为 `isError`（而非协议级 `-32602`），让模型在一次调用内看到结构化错误码并自纠错。

---

## 评分排序算法

### 条目检索（catalog_lookup）

分数 = 信号层级分 + 流行度微调，两者都封顶 1.0：

| 信号 | 基础分 | 说明 |
| --- | --- | --- |
| 名称精确匹配（大小写不敏感） | 1.0 | name 或 id 与查询完全一致 |
| 别名精确匹配 | 0.95 | 如查询 `expressjs` 命中别名 |
| 名称前缀匹配 | 0.90 | 如查询 `expr` |
| 别名前缀匹配 | 0.85 | |
| 名称词元重叠 | 0.60–0.83 | 按命中词元比例；上限刻意低于别名前缀层，保证层级序恒成立 |
| 摘要词元重叠 | 0.30–0.50 | 名称完全无关时 |

- 流行度微调 = `(1 − raw) × min(0.1, log₁₀(popularity)/100)`，只加在**当前信号层级的余量内**，
  保证「精确 > 别名 > 前缀 > 词元重叠」的层级永不被流行度反转；
- 分词规则：英文按词、中文逐字（无空格语言）；
- 同分时按流行度降序（稳定排序）。

### 文档片段排序（doc_extract 的 focus）

- 片段分数 = `(2 × 标题命中词数 + 正文命中词数) / (2 × 查询词数)`；
- 标题命中权重是正文的两倍；零命中片段被过滤；超过 `maxSections` 截断；
- 不传 `focus` 时按索引原始顺序返回。

### 版本选择（catalog_releases / doc_extract 的 version）

`latest` / 缺省 → 最新稳定版（无稳定版时取最新预发布版）；
精确版本号 → 唯一命中（容忍 `v`/`V` 前缀，build 元数据如 `+build.2` 不参与比较）；
前缀（`5` / `5.1` / `5.1.x` / `5.1.*`）→ 最新同前缀版本；
预发布标识符按 semver 规则比较（`rc.10` > `rc.9`）；
无匹配 → `version` 错误并附候选列表。

---

## 缓存策略

- 一个进程内 **TTL + LRU** 内存缓存（默认 256 条，存活 600 秒），缓存对象：
  远程索引拉取结果与查询结果；本地索引本身只在进程内解析一次（静态数据）；
- TTL 可配：`--cache-ttl <sec>`（0–86400，0 = 关闭），`--no-cache` 为关闭的快捷方式；
- **失败冷却（负缓存）**：远程索引拉取失败后进入 30 秒冷却期，期间直接降级本地、
  不重复发起网络请求（避免宕机时每次查询都干等超时）；冷却期过后自动重试，源恢复即自愈。
  注意：冷却依赖缓存存储，`--no-cache` / `--cache-ttl 0` 下不生效（此时每次失败都会真实重试）；
- LRU 按访问序淘汰，缓存统计（命中/未命中/淘汰数）用 `--debug` 在进程退出时输出到 stderr；
- 本地索引的冷启动零成本（同步读取）；远程索引首次拉取后所有查询命中缓存。

---

## 离线模式与远程索引

### 离线模式（默认）

不配置 `--index-url` 即为完全离线：使用内置 `data/index.json`（3 个示范条目：
Express 5.1/4.21 双版本、Zod 3.24/3.23、Day.js 1.11，含版本差异演示）。
内置索引可替换为你的自有索引（`--local-index <path>`），格式见下。

### 远程索引

索引是**开放 JSON 格式**，可托管在任意静态 HTTP 服务上（GitHub Pages、对象存储、内网文件服务器均可）：

```
索引地址（--index-url / DOCTROVE_INDEX_URL，传 index.json 所在目录的 URL）
   └─ <地址>/index.json   ← 插件按此路径拉取
```

本地架设最小实现（零依赖，支持 ETag 条件请求；默认只监听本机回环，暴露局域网需自行改 host）：

```bash
node scripts/serve-index.mjs [目录] [端口]   # 默认 ./data，端口 8730
node src/entry.js --index-url http://localhost:8730
```

远程与本地的关系：**远程在前、本地兜底**。远程拉取失败（断网/超时/非 2xx/格式非法）时
自动降级到本地索引继续服务，每个条目与结果都带 `source` 标注，模型可判断数据新鲜度。

### 索引格式规范

```jsonc
{
  "format": "doctrove-index@1",          // 必填，版本化的格式标识
  "updatedAt": "2026-08-16T00:00:00.000Z",
  "entries": [{
    "id": "express",                      // 必填，规范 id（全局唯一）
    "name": "Express",                    // 必填，展示名
    "summary": "Node.js 极简 Web 应用框架",
    "aliases": ["expressjs"],             // 检索别名（字符串数组）
    "homepage": "https://expressjs.com",
    "popularity": 1200,                   // 流行度权重（评分微调用）
    "versions": ["5.1.0", "4.21.2"],      // 必填，可用版本
    "volumes": {                          // 必填，版本 → 文档卷
      "5.1.0": {
        "summary": "本版本要点（可选）",
        "sections": [{                    // 必填，文档片段（元素必须是非数组对象）
          "heading": "路由处理器",        // 片段标题（排序权重 2 倍）
          "path": "https://expressjs.com/en/5x/api.html#app.METHOD",  // 溯源链接（可选）
          "body": "片段正文（可含代码示例）"
        }]
      }
    }
  }]
}
```

校验规则：`format` 必须为 `doctrove-index@1`；`entries` 数组；id/name 非空且 id 唯一；
`aliases` 必须是字符串数组；每个 `versions` 里的版本都必须有对应的 `volumes` 卷，
卷的 `sections` 必须是合法对象数组。
不合法的索引会被拒绝（远程源报 `network` 并降级本地，本地源报 `config` 退出）。

---

## 配置参考

分层优先级：**命令行 > 环境变量 > 配置文件 > 默认值**。

| 配置项 | 命令行 | 环境变量 | 配置文件键 | 默认 |
| --- | --- | --- | --- | --- |
| 远程索引地址 | `--index-url <url>` | `DOCTROVE_INDEX_URL` | `indexUrl` | 无（离线） |
| 本地索引路径 | `--local-index <path>` | `DOCTROVE_LOCAL_INDEX` | `localIndex` | 内置 `data/index.json` |
| 缓存存活（秒） | `--cache-ttl <sec>` / `--no-cache` | `DOCTROVE_CACHE_TTL` | `cacheTtl` | 600 |
| 远程超时（毫秒） | `--timeout-ms <ms>` | `DOCTROVE_TIMEOUT_MS` | `timeoutMs` | 15000 |
| 调试日志 | `--debug` | `DOCTROVE_DEBUG` | `debug` | false |
| 配置文件 | `--config <path>` | `DOCTROVE_CONFIG` | — | 无 |

配置文件为 JSON（示例见 `examples/doctrove.config.example.json`）。所有配置均为只读参数，
插件不发起任何写操作、不写任何本地状态。空字符串环境变量视为未设置（回退默认值）；
`cacheTtl: 0` 是合法值（关闭缓存）。

---

## 测试

```bash
node --test        # 93 个用例：评分/版本/缓存/配置/JSON-RPC/引擎/端到端/索引托管
```

测试覆盖：评分排序边界（层级不可被流行度反转）、版本选择（latest/精确/前缀/预发布/
build 元数据）、多源合并与降级自愈、失败冷却、缓存 TTL/LRU、配置优先级与非法值/空串、
MCP 协议（未初始化门禁、版本协商、错误折叠、冲突消息）、子进程级端到端
（握手 + 三工具 + 错误路径 + 优雅退出）、索引托管（ETag/304/穿越防护/symlink 逃逸/畸形编码）。

---

## 目录结构

```
src/
  entry.js            CLI 入口：配置 → 装配 → stdio MCP 会话
  core/               config（分层配置）、errors（统一错误模型）、version
  vault/ttl.js        TTL + LRU 内存缓存
  catalog/            scoring（评分排序）、releases（版本选择）、store（目录中枢）
  supply/provider.js  数据源：LocalSource / RemoteSource + 索引校验
  protocol/           jsonrpc / engine（MCP 会话引擎）/ transport（stdio 行协议）
  tools/              registry（注册表+参数校验）、definitions（3 个工具）
  bridge/             plugin.js（dsh Cordis 插件）、client.js（MCP stdio 客户端）
data/index.json       内置离线索引（示范数据，可替换）
scripts/serve-index.mjs  零依赖索引托管脚本
test/                 93 个测试用例
```

## 许可

MIT（见 LICENSE）。
