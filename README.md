# opencode-donsetch

[![CI](https://github.com/donbowman/opencode-donsetch/actions/workflows/ci.yml/badge.svg)](https://github.com/donbowman/opencode-donsetch/actions/workflows/ci.yml)

[DonSeTch](https://github.com/dondai44423/donsetch) as an [OpenCode](https://opencode.ai)
v2 websearch provider.

OpenCode's built-in `websearch` tool asks a provider for ranked URLs. Its stock
providers all need an API key. DonSeTch is a keyless, local multi-engine
aggregator (10+ backends, consensus ranking, local rerank), so this plugin
registers it as one more provider: if `donsetch` is installed, search works,
with no account and no credential to connect.

| | |
|---|---|
| Provider ID | `donsetch` |
| Provider name | `DonSeTch` |
| Backend | local `donsetch search --json` |
| Credentials | none |
| Results per search | 8 |

## Quick start

```bash
# 1. Install DonSeTch (any of these)
npm install -g donsetch
# brew tap dondai44423/donsetch && brew install donsetch
# cargo install donsetch

# 2. Add the plugin
opencode plugin add github:donbowman/opencode-donsetch#v0.1.0
```

3. Select the provider in `opencode.jsonc`:

```jsonc
{
  "websearch": {
    "provider": "donsetch"
  },
}
```

4. Restart OpenCode and run a search.

Without step 3, the first `websearch` call asks which provider to use. Choose
DonSeTch under "Choose another provider" and OpenCode remembers the answer. With
`"provider": "random"`, DonSeTch joins the pool of providers OpenCode rotates
through.

The plugin only registers the provider. It never changes the active provider
itself, so an existing `"provider": "deepseek"` (or `firecrawl`, or anything
else) keeps working after installation.

## Requirements

- OpenCode v2 (developed against 2.1.4)
- DonSeTch 3.1 or later, with `donsetch` on `PATH`. Verified against 3.1.0 and
  4.10.2.

`donsetch --version` must work in the environment that runs the OpenCode server.
When the server runs as a service, that is the service's `PATH`, not the shell
you installed from. If the binary lives somewhere else, set `DONSETCH_BIN` in
the service environment:

```bash
DONSETCH_BIN=/home/me/.cargo/bin/donsetch
```

No API key, account, or DonSeTch configuration is needed. Optional BYOK search
keys configured with `donsetch keys add` are used automatically, because the
provider runs the normal DonSeTch search path.

## Install

### From GitHub

```bash
opencode plugin add github:donbowman/opencode-donsetch#v0.1.0
```

This appends the spec to `plugins` in your global `opencode.json`. Adding it by
hand works the same way:

```jsonc
{
  "plugins": ["github:donbowman/opencode-donsetch#v0.1.0"]
}
```

To upgrade, change the tag. The plugin is one file, so no build step and no
dependencies are involved.

### From a local file

Copy `index.ts` into `~/.config/opencode/plugins/donsetch/` (or
`.opencode/plugins/donsetch/` for one project). OpenCode loads local plugin
files automatically, so no `plugins` entry is needed.

Pick one method. Both register the plugin id `opencode.donsetch`; a local copy
and a GitHub install of the same plugin would be duplicates.

Restart the OpenCode server after either install. On a running service, a
location reload also picks it up.

## Verify it loaded

A successful setup logs one line to the server log:

```text
[donsetch] registered websearch provider "donsetch" (/path/to/donsetch)
```

The provider then appears alongside the built-in ones wherever OpenCode lists
websearch providers, including the first-run picker. If it is missing, the same
log has a warning naming the reason, usually that the binary was not on the
server's `PATH`.

If `websearch.provider` names `donsetch` but results come from another provider,
the plugin did not load and OpenCode fell back to the remembered provider.
Check the warning in the log.

## What a search does

For each query the plugin runs:

```text
donsetch search --json -q --max-results 8 --deadline-ms 25000 -- <query>
```

The binary is executed directly, never through a shell, and the query always
follows `--`, so a query that starts with a dash is treated as text. The CLI
envelope maps like this:

| DonSeTch field | OpenCode result field |
|---|---|
| `url` | `url` |
| `title` | `title`, omitted when empty |
| `snippet`, or `summary` when there is no snippet | `content` |
| `date` | `time.published` in epoch milliseconds, omitted when missing or unparseable |
| `score`, `consensus`, `engines` | unused (ranking is already applied) |

Only snippets cross over. The plugin never asks DonSeTch to fetch page bodies;
if the model needs a page it can use its normal fetch tools.

OpenCode applies its own `websearch` permission rules before the provider runs,
so existing allow/ask/deny policy is unchanged.

## Failure behaviour

- **Not installed.** At setup the plugin scans `PATH` without spawning anything.
  If the binary is missing, it logs one warning and registers no provider, so
  the picker does not offer a provider that cannot work.
- **Installed later.** Restart OpenCode, or set `DONSETCH_BIN` and reload.
- **Search failure.** A non-zero exit with `ok:false` surfaces DonSeTch's own
  message (for example a deadline or engine error) as the tool error. Partial
  results are returned when the CLI produced some.
- **Timeouts and cancellation.** DonSeTch gets a 25 second deadline; a 30 second
  hard kill backs it up. Cancelling the session kills the child process.
- **Rate limits.** DonSeTch rotates engines and handles its own BYOK cooldowns,
  so the plugin does not translate anything into HTTP 429. OpenCode's
  random-mode cooldown applies to providers that return 429 themselves and is
  not used here.

## Relation to the DonSeTch MCP server

These are independent integrations and can run side by side:

- `donsetch mcp` in `mcp.servers` gives the agent tools such as `web_fetch`,
  `web_search`, `web_crawl` and `web_screenshot`.
- This plugin wires the same search engine into OpenCode's built-in `websearch`
  tool.

The plugin shells out to the CLI, so it does not need the MCP daemon to be
running, and it does not reuse that stdio connection. A shared HTTP daemon
(`donsetch mcp --http --port 8765`) could be used instead, but the CLI is
stateless and fast enough that the plugin does not require it.

## Privacy and safety

- The plugin itself makes no network requests and stores no data.
- Queries are sent by DonSeTch to the search engines it aggregates, from your
  machine, exactly as `donsetch search` does. Some engines are third parties;
  see the DonSeTch documentation for its engine list and proxy options.
- The plugin executes only the resolved `donsetch` binary, with an argument
  array and no shell. `DONSETCH_BIN` is trusted input: point it at the real
  binary only.
- No credentials are read, written, or forwarded. Optional DonSeTch BYOK keys
  stay in DonSeTch's own key store and are used by the CLI, not by this plugin.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Provider missing from the picker | `donsetch` not on the server's `PATH` | Set `DONSETCH_BIN`, then restart or reload the server |
| `donsetch websearch: ... was not found on PATH` | Binary removed after setup | Reinstall, or set `DONSETCH_BIN` |
| `donsetch websearch: could not run ...` | Override is not executable, or permissions | Check `donsetch --version` as the server user |
| Search error mentioning `deadline_ms` | Engines were slow | Retry; inspect with `donsetch search "<query>" --json` |
| Configured `donsetch` but another provider answers | Plugin did not load | Check the server log for the `[donsetch]` warning |
| Empty results | Engines returned nothing usable | Try a different query, or run the same query from the CLI |

Run the CLI directly to separate OpenCode from DonSeTch when debugging:

```bash
donsetch search "rust async traits" --json --max-results 3
```

## Development

```bash
npm install
npm test      # typecheck + smoke
```

The smoke test drives the provider against a fake `donsetch` executable: no
network, no DonSeTch install. It covers registration, argument construction,
envelope mapping, error messages, `PATH` discovery and `DONSETCH_BIN`.

`index.ts` has no runtime imports and no dependencies. OpenCode supplies the
plugin context; `child_process` and `fs` come from `process.getBuiltinModule`.
Keep it that way so a copied file runs as-is.

## License

MIT
