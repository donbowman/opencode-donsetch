/**
 * Smoke test for opencode-donsetch.
 *
 * Loads the plugin through a mock OpenCode v2 setup context and drives the
 * provider against a fake `donsetch` executable, so it never touches the
 * network and does not require DonSeTch to be installed. It asserts:
 *
 *   - registration only happens when the binary can be found,
 *   - the CLI is invoked without a shell and the query is passed after `--`,
 *   - the JSON envelope maps to OpenCode's websearch result shape,
 *   - classified failures surface donsetch's own message,
 *   - PATH discovery works as well as the DONSETCH_BIN override.
 *
 * Run (Node >= 23.6 strips types natively):
 *   node test/smoke.ts
 * or:
 *   npm test
 */

import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import plugin from "../index.ts"

type Loose = Record<string, any>

/** Records its argv, then prints whatever the test put in FAKE_JSON. */
const FAKE_BIN = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_ARGS"
if [ -n "$FAKE_ERROR_JSON" ]; then
  printf '%s' "$FAKE_ERROR_JSON"
  exit 2
fi
printf '%s' "$FAKE_JSON"
`

function makeCtx() {
  const providers: Loose[] = []
  const ctx: any = {
    location: { directory: process.cwd() },
    websearch: {
      transform: async (callback: (editor: Loose) => void) => {
        callback({
          add: (provider: Loose) => providers.push(provider),
          default: {
            get: () => undefined,
            set: () => {
              throw new Error("the plugin must not change the active websearch provider")
            },
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  return { providers, ctx }
}

function readArgs(file: string): string[] {
  const raw = readFileSync(file, "utf8")
  return raw.length ? raw.replace(/\n$/, "").split("\n") : []
}

async function main(): Promise<void> {
  if (process.platform === "win32") {
    console.log("smoke: skipped on Windows (the fake binary is a POSIX shell script)")
    return
  }

  const dir = mkdtempSync(join(tmpdir(), "opencode-donsetch-"))
  const savedPath = process.env.PATH
  try {
    const bin = join(dir, "donsetch")
    const argsFile = join(dir, "args.txt")
    writeFileSync(bin, FAKE_BIN)
    chmodSync(bin, 0o755)

    process.env.DONSETCH_BIN = bin
    process.env.FAKE_ARGS = argsFile
    process.env.FAKE_JSON = ""

    /* 1. registration when the binary exists --------------------------- */
    const first = makeCtx()
    await plugin.setup(first.ctx)
    assert.equal(first.providers.length, 1, "provider registered")
    const provider = first.providers[0]
    assert.equal(provider.id, "donsetch")
    assert.equal(provider.name, "DonSeTch")

    /* 2. envelope mapping ---------------------------------------------- */
    const published = "2026-01-02T03:04:05Z"
    process.env.FAKE_JSON = JSON.stringify({
      ok: true,
      content: "# Search\n",
      meta: {
        results: [
          { title: "Alpha", url: "https://a.example/1", snippet: "alpha snippet" },
          { url: "https://b.example/2", summary: "beta summary" },
          { title: "no url" },
          { title: "Gamma", url: "https://c.example/3", snippet: "gamma snippet", date: published },
        ],
      },
    })
    const results = await provider.execute({ query: "rust async traits" }, {})
    assert.deepEqual(results, [
      { url: "https://a.example/1", title: "Alpha", content: "alpha snippet", time: {} },
      { url: "https://b.example/2", content: "beta summary", time: {} },
      {
        url: "https://c.example/3",
        title: "Gamma",
        content: "gamma snippet",
        time: { published: Date.parse(published) },
      },
    ])

    /* 3. invocation: flags, no shell, query after `--` ------------------ */
    const args = readArgs(argsFile)
    assert.deepEqual(args.slice(0, 8), [
      "search",
      "--json",
      "-q",
      "--max-results",
      "8",
      "--deadline-ms",
      "25000",
      "--",
    ])
    assert.equal(args[8], "rust async traits")
    assert.equal(args.length, 9, "query travels as a single argv element")

    const dashQuery = "-site:example.com a b"
    await provider.execute({ query: dashQuery }, {})
    assert.equal(readArgs(argsFile)[8], dashQuery, "a leading dash cannot become a flag")

    /* 4. empty query never spawns -------------------------------------- */
    writeFileSync(argsFile, "")
    await assert.rejects(provider.execute({ query: "   " }, {}), /query is empty/)
    assert.equal(readFileSync(argsFile, "utf8"), "", "no process was started")

    /* 5. classified failure surfaces donsetch's message ----------------- */
    process.env.FAKE_ERROR_JSON = JSON.stringify({
      ok: false,
      error: { kind: "transient", message: "search: deadline_ms exceeded for \"rust async\"" },
      meta: { ok: false, code: "deadline.hit" },
    })
    await assert.rejects(provider.execute({ query: "rust async" }, {}), /deadline_ms exceeded/)
    delete process.env.FAKE_ERROR_JSON

    /* 6. a missing override registers nothing --------------------------- */
    process.env.DONSETCH_BIN = join(dir, "does-not-exist")
    const missing = makeCtx()
    await plugin.setup(missing.ctx)
    assert.equal(missing.providers.length, 0, "no provider without a binary")

    /* 7. PATH discovery ------------------------------------------------ */
    delete process.env.DONSETCH_BIN
    process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`
    process.env.FAKE_JSON = JSON.stringify({ ok: true, meta: { results: [] } })
    const discovered = makeCtx()
    await plugin.setup(discovered.ctx)
    assert.equal(discovered.providers.length, 1, "binary found on PATH")
    await discovered.providers[0].execute({ query: "from path" }, {})
    assert.equal(readArgs(argsFile)[8], "from path")

    console.log("smoke: ok")
  } finally {
    process.env.PATH = savedPath
    delete process.env.DONSETCH_BIN
    delete process.env.FAKE_ARGS
    delete process.env.FAKE_JSON
    delete process.env.FAKE_ERROR_JSON
    rmSync(dir, { recursive: true, force: true })
  }
}

await main()
