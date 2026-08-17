[简体中文](README.zh.md)

# doctrove — Versioned library documentation retrieval (agent toolset)

`doctrove` is a **versioned documentation retrieval** plugin for coding agents: it maintains a "library documentation catalog index", letting agents fetch **accurate, versioned, traceable** API documentation snippets on demand while writing code — instead of guessing API usage from training memory — and thereby avoiding "APIs that don't exist in the docs", "outdated signatures", and "fabricated parameters".

- **Zero runtime dependencies**: uses only Node.js built-ins (`fetch`, `node:test`), runs without installing any package;
- **Standard MCP stdio server**: any MCP-capable client (dsh, Claude Code, Codex, opencode, etc.) can connect;
- **Built for dsh**: ships a dsh bundle (`cordis.patch.yml` + a self-built bridge plugin), one-step integration via `dsh plugin add`, tools automatically appear in the model's tool list (`mcp__doctrove__*`);
- **Versioned**: every entry carries multiple documentation volumes, supporting "latest stable / exact version / prefix version (`4` → 4.21.x)" selection;
- **Scored, ranked results**: entry retrieval and documentation snippets both carry 0–1 relevance scores and hit signals, so the model can verify "why it ranked first";
- **Offline-capable**: ships with a built-in local demo index (`data/index.json`), runs without networking or remote sources;
- **Self-hostable remote index**: the index is an open JSON format that can be hosted on any static hosting (a zero-dependency hosting script is included);
- **Smart caching**: TTL + LRU in-memory cache, remote index and query results expire automatically per configuration, `--no-cache` disables it in one shot;
- **Graceful degradation**: when the remote index is unreachable, falls back to the local index automatically, results are tagged with `source` so the agent can tell data provenance.

---

## Quick start

### Method A: connect directly from any MCP client

```bash
# Requires Node.js >= 18.17; no arguments means offline mode (built-in index)
node src/entry.js
```

Example config line using the official dsh bridge (also applies to Claude Code / Codex MCP config):

```yaml
# dsh: insert into $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: mcp-doctrove
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: doctrove
        transport: stdio
        command: node
        args: ['/absolute/path/src/entry.js']
```

Once connected, the model sees 3 tools: `catalog_lookup`, `catalog_releases`, `doc_extract`
(generic MCP clients see the bare names; in the dsh scenario they carry the `mcp__doctrove__` prefix, see below).

### Method B: install as a dsh plugin bundle (recommended)

This plugin is declared as a dsh bundle (the `dsh.bundle` field in `package.json`). Run the following in the plugin checkout directory:

```bash
dsh plugin --profile web add .
```

- On first use it automatically initializes the `web` profile and adds this package to `dsh.profile.bundles`;
- The `doctrove/bridge` plugin defined in `cordis.patch.yml` spawns this MCP server inside the dsh process,
  and after the handshake registers all tools into `ctx.tools`, **no manual config changes needed**;
- Offline-capable: the built-in index is loaded by default; to use a remote index, configure `args: ['--index-url', ...]` on the bridge line (see below);
- Uninstall: `dsh plugin --profile web remove doctrove`.

### Installing in DSH

```bash
dsh plugin --profile demo add github:JohnXu22786/docs-retriever
```

- `demo` is a dsh profile: it is created automatically on first use, and the package is added to `dsh.profile.bundles`;
- The `cordis.patch.yml` inside the package defines the `doctrove/bridge` plugin, which starts this MCP server within the dsh process and registers all tools into `ctx.tools` after the handshake — no manual configuration needed;
- Offline-capable out of the box: the built-in index is loaded by default; configure `args: ['--index-url', ...]` on the bridge line to use a remote index (see below);
- Removal:

```bash
dsh plugin --profile demo remove doctrove
```

After installing, restart dsh, then in a session you can simply say:

> "Write an Express 5 endpoint with `:id` route params and a JSON response — look up the exact route-param syntax first"

The corresponding tool call chain: `mcp__doctrove__catalog_lookup` (confirm express) →
`mcp__doctrove__doc_extract` (id=express, focus=route parameters).

> Note: dsh enables no MCP servers by default (every server command is trusted code executed outside the sandbox),
> and this plugin's bundle line is the "enable" action itself; only install plugins you trust.

---

## dsh integration notes (how the pluginized harness loads it)

dsh uses the Cordis plugin framework, and the composition unit is a **bundle**: an npm package + a patch layer. The loading chain is:

```
package.json（dsh.bundle.patch → ./cordis.patch.yml）
  └─ one line in cordis.patch.yml: name: 'doctrove/bridge'
       └─ src/bridge/plugin.js（Cordis plugin, inject: ['tools']）
            ├─ spawns src/entry.js with Node itself（MCP server subprocess, stdio）
            ├─ completes the initialize / tools/list handshake
            └─ registers each tool as mcp__doctrove__<toolname> into ctx.tools
```

- **Tool interface**: the model-visible tool names are `mcp__<serverName>__<raw tool name>`, `serverName` defaults to `doctrove`;
- **Events/skills**: this plugin registers no events or skills; it exposes capabilities only through the `ctx.tools` tool interface (read-only tools, no side effects);
- **Lifecycle**: the handshake and registration happen during the plugin's `apply`; on unload the subprocess is killed and all tools are deregistered automatically
  (registered via `ctx.effect` cleanup, no leftovers after hot reload/unload);
- **Two bridge options**: the self-built bridge `doctrove/bridge` bundled with this package (zero-dependency, works out of the box) and the
  official `@deepseek-ai/dsh-mcp-client` config line (see `examples/overlay-for-dsh.yml.example`);
  tool naming and behavior are identical — pick either one, don't enable both;
- **Environment variables**: dsh filters credential-like variables from MCP subprocess environments; the self-built bridge's subprocess inherits the host environment,
  so `DOCTROVE_INDEX_URL` and similar pass through, and can also be set explicitly with `env:` on the bridge line.

### Common dsh issues

| Symptom | Fix |
| --- | --- |
| Tools missing from the list | Check that the `cordis.patch.yml` line took effect (`dsh --profile <name> --dump-config` to inspect layers), confirm no startup log errors |
| Want a remote index | Configure `args: ['--index-url', 'https://your-index-url']` on the bridge line (directory root), or `env: { DOCTROVE_INDEX_URL: '...' }` |
| Want looser caching | Configure `args: ['--cache-ttl', '3600']` on the bridge line; use `--no-cache` for testing/debugging |
| pnpm >=10 rejects git-installed prepare scripts | This plugin is pure JS with no build script, so it is not affected; install from checkout or tarball |

---

## Tool list (3 tools, all read-only)

| Tool | Purpose | Main parameters |
| --- | --- | --- |
| `catalog_lookup` | Search the doc catalog by name/description, return candidates with scores and hit signals | `query` (required), `limit` |
| `catalog_releases` | List available and recommended versions of an entry | `id` (required) |
| `doc_extract` | Extract doc snippets for an entry/version/focus (relevance-ranked) | `id` (required), `version`, `focus`, `maxSections` |

### catalog_lookup

Search the doc catalog. When unsure of a library's canonical id, call this first, then use the returned `id` with `doc_extract`.

```jsonc
// request
{ "query": "express", "limit": 5 }
// response (structuredContent summary)
{
  "results": [{
    "id": "express", "name": "Express", "summary": "Minimal web framework for Node.js",
    "score": 1.0, "matches": ["exact name match"],
    "versions": ["5.1.0", "4.21.2"], "latest": "5.1.0", "source": "local:.../data/index.json"
  }],
  "total": 1, "sources": ["local:.../data/index.json"]
}
```

### catalog_releases

View an entry's version list and recommended version, useful for checking whether a target version is available (`doc_extract` supports the same version syntax).

```jsonc
{ "id": "express" }
// → { "id": "express", "name": "Express", "latest": "5.1.0",
//     "versions": ["5.1.0", "4.21.2"], "source": "local:..." }
```

### doc_extract

Extract documentation. `focus` describes one concept at a time (e.g. "route parameters"); split cross-concept questions into multiple calls
to avoid diluted results; `version` defaults to the latest stable release.

```jsonc
{ "id": "express", "version": "5", "focus": "wildcard" }
// → {
//     "id": "express", "name": "Express", "version": "5.1.0",
//     "releaseKind": "prefix", "releaseNote": "prefix match 5.x → latest 5.x release",
//     "sections": [{ "heading": "Wildcard routes", "score": 0.5, "matches": ["heading hit: 1 word"], ... }],
//     "source": "local:..."
//   }
```

Errors are always structured `isError` results, with `error.code` taking one of: `validation` / `not-found` / `version` /
`network` / `timeout` / `internal`, and `message` carrying actionable hints (e.g. candidate versions when the requested one is unavailable).
Parameter-validation failures are likewise folded into `isError` (rather than the protocol-level `-32602`), so the model sees a structured error code in one call and can self-correct.

---

## Scoring and ranking algorithm

### Entry retrieval (catalog_lookup)

Score = signal-tier score + popularity fine-tuning, both capped at 1.0:

| Signal | Base score | Notes |
| --- | --- | --- |
| Exact name match (case-insensitive) | 1.0 | name or id exactly equals the query |
| Exact alias match | 0.95 | e.g. query `expressjs` hits an alias |
| Name prefix match | 0.90 | e.g. query `expr` |
| Alias prefix match | 0.85 | |
| Name token overlap | 0.60–0.83 | proportional to hit tokens; ceiling deliberately below the alias-prefix tier to keep tier order invariant |
| Summary token overlap | 0.30–0.50 | when the name is completely unrelated |

- Popularity fine-tuning = `(1 − raw) × min(0.1, log₁₀(popularity)/100)`, applied only within the **headroom of the current signal tier**, so "exact > alias > prefix > token overlap" can never be inverted by popularity;
- Tokenization: English by word, Chinese per character (space-less languages);
- Ties are broken by popularity, descending (stable sort).

### Doc snippet ranking (doc_extract focus)

- Snippet score = `(2 × heading hit words + body hit words) / (2 × query words)`;
- Heading hits count double the body; zero-hit snippets are filtered out; truncated past `maxSections`;
- Without `focus`, snippets return in the index's original order.

### Version selection (catalog_releases / doc_extract version)

`latest` / default → latest stable release (or latest prerelease when no stable exists);
exact version → unique match (a `v`/`V` prefix is tolerated; build metadata such as `+build.2` does not participate in comparison);
prefix (`5` / `5.1` / `5.1.x` / `5.1.*`) → latest release matching the prefix;
prerelease identifiers compare per semver rules (`rc.10` > `rc.9`);
no match → `version` error with a candidate list attached.

---

## Caching strategy

- One **TTL + LRU** in-memory cache per process (default 256 entries, 600 s lifetime), caching:
  remote index fetches and query results; the local index itself is parsed once per process (static data);
- TTL is configurable: `--cache-ttl <sec>` (0–86400, 0 = disabled), `--no-cache` is a shortcut for disabled;
- **Failure cooldown (negative caching)**: after a remote index fetch fails, a 30-second cooldown kicks in during which the plugin falls back to local
  and does not repeat the network request (avoiding a timeout wait on every query while the source is down); after the cooldown it retries automatically and heals itself once the source recovers.
  The cooldown timing is independent of the cache TTL (a `--cache-ttl` shorter than the cooldown does not cut it short);
  it does not apply under `--no-cache` / `--cache-ttl 0` (every failure then really retries);
- LRU evicts by access order; cache stats (hits/misses/evictions) are printed to stderr at exit with `--debug`;
- Local-index cold start is free (synchronous read); after the first remote fetch, all queries hit the cache.

---

## Offline mode and remote index

### Offline mode (default)

Without `--index-url` the plugin is fully offline: it uses the built-in `data/index.json` (3 demo entries:
Express 5.1/4.21 dual versions, Zod 3.24/3.23, Day.js 1.11, including a version-difference demo).
The built-in index can be replaced with your own (`--local-index <path>`), see the format below.

### Remote index

The index is an **open JSON format** hostable on any static HTTP service (GitHub Pages, object storage, intranet file servers all work):

```
index URL（--index-url / DOCTROVE_INDEX_URL，the URL of the directory containing index.json）
   └─ <url>/index.json   ← fetched by the plugin along this path
```

Minimal local hosting (zero dependencies, supports ETag conditional requests; by default listens on the local loopback only — change `host` yourself to expose on LAN):

```bash
node scripts/serve-index.mjs [dir] [port]   # default ./data, port 8730
node src/entry.js --index-url http://localhost:8730
```

Relationship between remote and local: **remote first, local as fallback**. When the remote fetch fails (offline/timeout/non-2xx/invalid format),
the plugin degrades to the local index and keeps serving; every entry and result carries a `source` tag so the model can judge data freshness.

### Index format specification

```jsonc
{
  "format": "doctrove-index@1",          // required, versioned format identifier
  "updatedAt": "2026-08-16T00:00:00.000Z",
  "entries": [{
    "id": "express",                      // required, canonical id (globally unique)
    "name": "Express",                    // required, display name
    "summary": "Minimal web framework for Node.js",
    "aliases": ["expressjs"],             // search aliases (array of strings)
    "homepage": "https://expressjs.com",
    "popularity": 1200,                   // popularity weight (scoring fine-tuning)
    "versions": ["5.1.0", "4.21.2"],      // required, available versions
    "volumes": {                          // required, version → documentation volume
      "5.1.0": {
        "summary": "highlights of this version (optional)",
        "sections": [{                    // required, doc snippets (elements must be non-array objects)
          "heading": "Route handlers",    // snippet title (2x ranking weight)
          "path": "https://expressjs.com/en/5x/api.html#app.METHOD",  // provenance link (optional)
          "body": "snippet body (may include code examples)"
        }]
      }
    }
  }]
}
```

Validation rules: `format` must be `doctrove-index@1`; `entries` must be an array; id/name non-empty and id unique;
`aliases` must be an array of strings; every version in `versions` must have a matching `volumes` volume,
and a volume's `sections` must be a valid array of objects.
Invalid indexes are rejected (remote sources report `network` and degrade to local; local sources report `config` and exit).

---

## Configuration reference

Precedence: **command line > environment variables > config file > defaults**.

| Setting | CLI | Environment variable | Config file key | Default |
| --- | --- | --- | --- | --- |
| Remote index URL | `--index-url <url>` | `DOCTROVE_INDEX_URL` | `indexUrl` | none (offline) |
| Local index path | `--local-index <path>` | `DOCTROVE_LOCAL_INDEX` | `localIndex` | built-in `data/index.json` |
| Cache lifetime (s) | `--cache-ttl <sec>` / `--no-cache` | `DOCTROVE_CACHE_TTL` | `cacheTtl` | 600 |
| Remote timeout (ms) | `--timeout-ms <ms>` | `DOCTROVE_TIMEOUT_MS` | `timeoutMs` | 15000 |
| Debug logging | `--debug` | `DOCTROVE_DEBUG` | `debug` | false |
| Config file | `--config <path>` | `DOCTROVE_CONFIG` | — | none |

The config file is JSON (example: `examples/doctrove.config.example.json`). All configuration is read-only:
the plugin performs no writes and persists no local state. Empty-string environment variables count as unset (defaults apply);
`cacheTtl: 0` is a valid value (cache disabled).

---

## Testing

```bash
node --test        # 105 cases: scoring/versions/cache/config/JSON-RPC/engine/e2e/index hosting
```

Coverage: scoring-ranking boundaries (tier order can never be inverted by popularity), version selection (latest/exact/prefix/prerelease/
build metadata), multi-source merge and degradation self-healing, failure cooldown, cache TTL/LRU, config precedence plus invalid values and empty strings,
MCP protocol (uninitialized gate, version negotiation, error folding, conflicting messages), subprocess-level end-to-end
(handshake + 3 tools + error paths + graceful exit), index hosting (ETag/304/traversal protection/symlink escape/malformed encodings).

---

## Directory structure

```
src/
  entry.js            CLI entry: config → assembly → stdio MCP session
  core/               config (layered config), errors (unified error model), version
  vault/ttl.js        TTL + LRU in-memory cache
  catalog/            scoring (scoring/ranking), releases (version selection), store (catalog hub)
  supply/provider.js  data sources: LocalSource / RemoteSource + index validation
  protocol/           jsonrpc / engine (MCP session engine) / transport (stdio line protocol)
  tools/              registry (registry + parameter validation), definitions (3 tools)
  bridge/             plugin.js (dsh Cordis plugin), client.js (MCP stdio client)
data/index.json       built-in offline index (demo data, replaceable)
scripts/serve-index.mjs  zero-dependency index hosting script
test/                 105 test cases
```

## License

MIT (see [LICENSE](LICENSE)).
