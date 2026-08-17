# Changelog

## Unreleased

### Fixed

- `RemoteSource` 把失败冷却负缓存独立于主缓存 TTL 存储（`src/supply/provider.js`）：当 `--cache-ttl` 短于 30 秒冷却期时，冷却条目不再提前被主缓存淘汰，宕机期间的每个查询不再重复等待一次网络超时。冷却时长至少保持为冷却期；`--no-cache` / `--cache-ttl 0` 下仍不写入负缓存。
- 索引托管脚本（`scripts/serve-index.mjs`）对 `HEAD` 与命中 `If-None-Match` 的请求不再读取整个文件 body，仅回响应头 / 304，避免无谓 IO。

### Tests

- 补主缓存 TTL 短于冷却期时冷却仍完整生效的回归用例。
- 补 TTL 缓存过期重设、空容量（`maxEntries: 0`）与 LRU 重写计数的边界用例。
- 补版本选择的大写 `X` 模式、前导零前缀、不等长数值段等边界用例。
- 补索引托管 `HEAD` 请求头一致性与 304 组合用例。
- 测试总数 93 → 99。

## 1.0.0

- 首个版本：版本化库文档检索 MCP stdio server（零运行时依赖，可被 dsh 等插件化 harness 加载）。
- 内置离线索引（`data/index.json`）、远程索引拉取（TTL/LRU 缓存 + 失败冷却 + 本地降级自愈）。
- 三个只读工具：`catalog_lookup` / `catalog_releases` / `doc_extract`，带相关度评分与命中信号。
- 版本选择：latest / 精确 / 前缀（`4` → 4.x）；MCP 协议：initialize / tools/list / tools/call / ping。