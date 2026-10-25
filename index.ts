/**
 * opencode-donsetch — DonSeTch as an OpenCode v2 websearch provider.
 * https://github.com/donbowman/opencode-donsetch
 *
 * OpenCode ships five websearch providers (Exa, Firecrawl, Parallel, Tavily,
 * TinyFish) and lets a plugin add more through `ctx.websearch.transform`. This
 * plugin registers one provider, `donsetch`, that runs the local DonSeTch CLI:
 *
 *     donsetch search <query> --json --max-results N --deadline-ms N
 *
 * DonSeTch is a keyless search engine aggregator (10+ backends, local rerank,
 * consensus ranking). It needs no API key, so this plugin has no integration or
 * credential surface: if the binary is installed, search works.
 *
 * The provider is registered only when `donsetch` is found on PATH (or
 * DONSETCH_BIN points at it). It does not change the active provider: that
 * stays with `websearch.provider` in opencode.jsonc, or with the first-run
 * provider picker. Set `{ "websearch": { "provider": "donsetch" } }` to use it.
 *
 * Requires: OpenCode v2, donsetch on PATH (override with DONSETCH_BIN).
 *
 * No runtime imports, no dependencies: the host executes locally-discovered
 * plugin files as-is. The runtime contract is a default export of `{ id,
 * setup }`; types are kept local. Builtins come from `process.getBuiltinModule`.
 */

/* ------------------------------------------------------------------ *
 * Types (structural views of the OpenCode v2 plugin API)
 * ------------------------------------------------------------------ */

type Loose = Record<string, any>

interface Registration {
  dispose(): Promise<void> | void
}

interface WebSearchResult {
  url: string
  title?: string
  content?: string
  /** Always present; `{}` when the provider gives no publication time. */
  time: { published?: number }
}

interface WebSearchDefinition {
  id: string
  name: string
  execute(
    input: { query: string; providerID?: string },
    context?: { signal?: AbortSignal },
  ): Promise<WebSearchResult[]>
}

interface WebSearchEditor {
  add(provider: WebSearchDefinition): void
  default: {
    get(): string | false | undefined
    set(providerID: string | false): void
  }
}

interface SetupContext {
  location?: { directory?: string }
  websearch?: {
    transform(callback: (editor: WebSearchEditor) => void): Promise<Registration>
  }
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const PROVIDER_ID = "donsetch"
const PROVIDER_NAME = "DonSeTch"

const BIN_NAME = "donsetch"
const BIN_ENV = "DONSETCH_BIN"
const INSTALL_HINT =
  `Install it (npm install -g donsetch, brew install dondai44423/donsetch/donsetch, ` +
  `or cargo install donsetch) or point ${BIN_ENV} at the binary.`

const MAX_RESULTS = 8
/** Handed to donsetch so it can return its own deadline error first. */
const DEADLINE_MS = 25_000
/** Backstop: kills the child if donsetch itself never returns. */
const SEARCH_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

const LOG_PREFIX = "[donsetch]"

/* ------------------------------------------------------------------ *
 * Inline builtin loader (Node and Bun)
 * ------------------------------------------------------------------ */

function builtin(name: string): any {
  const p = process as unknown as { getBuiltinModule?: (n: string) => unknown }
  if (typeof p.getBuiltinModule === "function") {
    try {
      const mod = p.getBuiltinModule(name)
      if (mod) return mod
    } catch {
      /* fall through */
    }
  }
  const g = globalThis as unknown as { require?: (n: string) => unknown }
  if (typeof g.require === "function") {
    try {
      return g.require(name)
    } catch {
      /* fall through */
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function isExecutableFile(fs: any, file: string): boolean {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    // Windows has no executable bit; a .cmd/.exe name is enough there.
    if (process.platform !== "win32") fs.accessSync(file, fs.constants?.X_OK ?? 1)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve `donsetch` without spawning it. `donsetch --version` also probes for
 * a browser and costs several hundred milliseconds, which is too much to pay
 * on every OpenCode location load just to answer "is it installed?".
 */
function findOnPath(name: string): string | null {
  const fs = builtin("node:fs")
  const path = builtin("node:path")
  if (!fs?.statSync) return null
  const isWindows = process.platform === "win32"
  const extensions = isWindows
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""]
  const directories = (process.env.PATH ?? "").split(isWindows ? ";" : ":")
  for (const directory of directories) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path?.join
        ? path.join(directory, `${name}${extension}`)
        : `${directory}/${name}${extension}`
      if (isExecutableFile(fs, candidate)) return candidate
    }
  }
  return null
}

interface Discovery {
  bin?: string
  problem?: string
}

function discoverBinary(): Discovery {
  const fs = builtin("node:fs")
  const explicit = (process.env[BIN_ENV] ?? "").trim()
  if (explicit) {
    // Without fs we cannot check, so trust the override and let spawn report.
    if (!fs?.statSync || isExecutableFile(fs, explicit)) return { bin: explicit }
    return { problem: `${BIN_ENV} points to "${explicit}", which is not an executable file.` }
  }
  if (!fs?.statSync) return { bin: BIN_NAME }
  const found = findOnPath(BIN_NAME)
  return found ? { bin: found } : { problem: `"${BIN_NAME}" was not found on PATH.` }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

/* ------------------------------------------------------------------ *
 * Process runner (no shell)
 * ------------------------------------------------------------------ */

interface RunResult {
  code: number
  stdout: string
  stderr: string
  spawnError?: string
  timedOut?: boolean
  cancelled?: boolean
  overflow?: boolean
}

function runBinary(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  const cp = builtin("node:child_process")
  if (!cp?.spawn) {
    return Promise.resolve({ code: -1, stdout: "", stderr: "", spawnError: "child_process is unavailable in this runtime" })
  }
  if (signal?.aborted) {
    return Promise.resolve({ code: -1, stdout: "", stderr: "", cancelled: true })
  }
  return new Promise((resolve) => {
    let child: any
    try {
      child = cp.spawn(bin, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: "", spawnError: err instanceof Error ? err.message : String(err) })
      return
    }

    const outDecoder = new TextDecoder()
    const errDecoder = new TextDecoder()
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let cancelled = false
    let overflow = false

    const stop = () => {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }

    const onAbort = () => {
      cancelled = true
      stop()
    }
    if (signal) signal.addEventListener("abort", onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }

    child.stdout?.on("data", (chunk: Uint8Array) => {
      stdout += outDecoder.decode(chunk, { stream: true })
      if (stdout.length > MAX_OUTPUT_BYTES) {
        overflow = true
        stop()
      }
    })
    child.stderr?.on("data", (chunk: Uint8Array) => {
      // stderr is diagnostic only; keep the tail small.
      stderr = (stderr + errDecoder.decode(chunk, { stream: true })).slice(-MAX_OUTPUT_BYTES)
    })
    child.on("error", (err: Error) => {
      cleanup()
      resolve({ code: -1, stdout: "", stderr: "", spawnError: err.message, cancelled })
    })
    child.on("close", (code: number | null) => {
      cleanup()
      stdout += outDecoder.decode()
      stderr += errDecoder.decode()
      resolve({ code: code ?? 1, stdout, stderr, timedOut, cancelled, overflow })
    })
  })
}

/* ------------------------------------------------------------------ *
 * Response mapping
 * ------------------------------------------------------------------ */

/**
 * DonSeTch CLI returns an envelope: `{ ok, content, meta }`, where
 * `meta.results` is `{ title, url, snippet, score, consensus, engines }[]`.
 * Newer builds may also expose `structuredContent.results`; accept both.
 */
function envelopeResults(envelope: Loose): unknown[] {
  const candidates = [envelope?.meta?.results, envelope?.structuredContent?.results, envelope?.results]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
  }
  return []
}

function envelopeError(envelope: Loose): string {
  const err = envelope?.error
  if (typeof err === "string" && err.trim()) return err.trim()
  if (err && typeof err === "object") {
    const message = firstString(err.message, err.next_action)
    if (message) return message
  }
  return firstString(envelope?.meta?.error, envelope?.meta?.next_action, envelope?.message)
}

function toResult(item: Loose): WebSearchResult | undefined {
  const url = typeof item?.url === "string" ? item.url.trim() : ""
  if (!url) return undefined
  const title = firstString(item.title)
  const content = firstString(item.snippet, item.summary, item.content, item.description)
  const time: { published?: number } = {}
  const published = firstString(item.date, item.published, item.published_at)
  if (published) {
    const parsed = Date.parse(published)
    if (Number.isFinite(parsed)) time.published = parsed
  }
  return {
    url,
    ...(title ? { title } : {}),
    ...(content ? { content } : {}),
    time,
  }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

async function search(
  input: { query?: unknown } | undefined,
  context: { signal?: AbortSignal } | undefined,
  cwd: string,
): Promise<WebSearchResult[]> {
  const query = typeof input?.query === "string" ? input.query.trim() : ""
  if (!query) throw new Error("donsetch websearch: the search query is empty")

  const discovery = discoverBinary()
  if (!discovery.bin) throw new Error(`donsetch websearch: ${discovery.problem} ${INSTALL_HINT}`)

  const args = [
    "search",
    "--json",
    "-q",
    "--max-results",
    String(MAX_RESULTS),
    "--deadline-ms",
    String(DEADLINE_MS),
    // Everything after `--` is the query, even when it starts with a dash.
    "--",
    query,
  ]

  const result = await runBinary(discovery.bin, args, cwd, SEARCH_TIMEOUT_MS, context?.signal)

  if (result.cancelled) throw new Error("donsetch websearch: search cancelled")
  if (result.spawnError) {
    throw new Error(`donsetch websearch: could not run "${discovery.bin}": ${result.spawnError}`)
  }
  if (result.timedOut) {
    throw new Error(`donsetch websearch: search timed out after ${SEARCH_TIMEOUT_MS}ms`)
  }
  if (result.overflow) {
    throw new Error(`donsetch websearch: search output exceeded ${MAX_OUTPUT_BYTES} bytes`)
  }

  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  const detail = truncate(stderr, 500)

  if (!stdout) {
    throw new Error(
      `donsetch websearch: no output (exit ${result.code})${detail ? `: ${detail}` : ""}`,
    )
  }

  let envelope: Loose
  try {
    envelope = JSON.parse(stdout) as Loose
  } catch {
    throw new Error(
      `donsetch websearch: expected JSON from the CLI but got: ${truncate(stdout, 300)}`,
    )
  }

  const items = envelopeResults(envelope)
  const message = envelopeError(envelope)
  // A classified failure exits non-zero and carries `ok:false` + an error.
  // Return partial results when the CLI managed to produce some anyway.
  if (envelope?.ok === false || (result.code !== 0 && items.length === 0)) {
    const reason = message || detail || `exit ${result.code}`
    throw new Error(`donsetch websearch: ${truncate(reason, 1000)}`)
  }

  const results: WebSearchResult[] = []
  for (const item of items) {
    if (!item || typeof item !== "object") continue
    const mapped = toResult(item as Loose)
    if (mapped) results.push(mapped)
  }
  return results
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export default {
  id: "opencode.donsetch",
  async setup(ctx: SetupContext) {
    if (!ctx?.websearch?.transform) {
      console.warn(`${LOG_PREFIX} this OpenCode build has no websearch domain; provider not registered`)
      return
    }

    const discovery = discoverBinary()
    if (!discovery.bin) {
      console.warn(`${LOG_PREFIX} websearch provider not registered: ${discovery.problem} ${INSTALL_HINT}`)
      return
    }

    const cwd = ctx.location?.directory ?? process.cwd()
    const bin = discovery.bin

    await ctx.websearch.transform((editor) => {
      editor.add({
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        execute: (input, context) => search(input, context, cwd),
      })
      // Deliberately leave `editor.default` alone: the active provider is the
      // user's `websearch.provider` setting or their first-run pick.
    })

    console.log(`${LOG_PREFIX} registered websearch provider "${PROVIDER_ID}" (${bin})`)
  },
}
