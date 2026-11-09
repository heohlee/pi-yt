---
name: node-tests
description: "Trigger: Node tests, tests/*.test.ts, fakes for mpv/yt-dlp/fetch, type stripping limits, or CI test evidence. Govern pi-yt's test layout, fakes and real gates."
license: MIT
metadata:
  author: "heohlee"
  version: "1.0"
---

## Activation Contract

Use when changing pi-yt behavior or `tests/*.test.ts`, adding a fake for mpv, yt-dlp, fetch or the clock, or reporting test evidence for a PR.

Do not use for passive documentation or release copy with no test-behavior impact.

## Test Layout

| Item | Convention |
| --- | --- |
| Location | `tests/<area>.test.ts`, one file per module or behavior area |
| Runner | `node:test` (`test`, `describe`, `beforeEach`, `afterEach`), run by `node --test tests/` |
| Assertions | `node:assert/strict` only (`assert.equal`, `assert.deepEqual`, `assert.rejects`, `assert.match` when a pattern is the contract) |
| Language | TypeScript run natively by Node 24 or newer through type stripping; no build step, no test framework dependency |
| Fakes | Shared fakes live under `tests/`; reuse them before writing a new one |

## Hard Rules

1. **No real side effects.** Tests never reach the network, read real browser cookies or profiles, open keyrings, run the real `yt-dlp` or start the real `mpv`. Inject fakes for process spawning, the mpv IPC socket, `fetch` and the clock through the seams the code exposes. If a behavior has no seam, add one in the code under test rather than calling the real dependency.
2. **Fakes record, tests assert.** A spawn fake records the exact command and arguments and returns scripted stdout, stderr and exit code. A socket fake records the JSON IPC messages sent to mpv and replays scripted replies or events. A fetch fake matches the request and returns a scripted response, and fails the test on an unexpected request. A clock fake advances time explicitly; no test depends on real time.
3. **Isolated homes.** Any test that resolves config, cache or data paths runs against a fresh directory from `fs.mkdtemp(path.join(os.tmpdir(), "pi-yt-"))`, passed in or set through `HOME`/`XDG_*` before the code reads them, and removed in `afterEach` with `fs.rm(dir, { recursive: true, force: true })`. Never touch the real home directory. Restore any changed environment variable in cleanup, and do not run tests that change the environment concurrently.
4. **Fixtures are synthetic.** yt-dlp JSON, cookie-related errors and account data in fixtures are hand-written and minimal. Never commit cookies, browser profile data, real emails or captured full yt-dlp output.
5. **One test per rule.** Each test covers one behavior rule and asserts every observable effect of it: returned value or rendered text, the exact spawned command, sent IPC messages, and that rejected input leaves state unchanged. Cover the examples, boundaries and errors the rule names.
6. **Exact strings.** User-visible text, error messages and command arguments are asserted with exact `assert.equal`/`assert.deepEqual`, not substring or regex matches, unless the contract itself is a pattern.
7. **Public interface first.** Test through exported functions, the command handler or rendered output, not private internals.
8. **Bounded asynchrony.** Await promises and fake events. Do not wait on real timers with fixed sleeps; advance the fake clock. Every fake socket, server or child is closed in cleanup so `node --test` exits.
9. **Type stripping limits.** Node only erases types, so source and tests must not use `enum`, `namespace`, constructor parameter properties (`constructor(private x)`), or other syntax that needs transformation. Import host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) with `import type` only; they are peer dependencies and are not installed at test time. Use explicit `.ts` extensions in relative imports.

## Decision Gates

| Condition | Action |
| --- | --- |
| A pure function proves the contract | Test it directly instead of going through the popover |
| Behavior spawns yt-dlp or mpv | Use the spawn fake and assert the exact arguments |
| Behavior talks to a running mpv | Use the IPC socket fake |
| Behavior depends on paths or installed copies | Use a `mkdtemp` home |
| A test would need the network, real cookies or a real player | Stop: add a seam and a fake |
| A required gate cannot run | Report the exact failure and missing evidence; do not claim closing verification |

## Execution Steps

1. Read the existing tests for the area and reuse their fakes and helpers.
2. Add a focused behavior test, observe its intended failure, then implement the smallest change. Preserve previous behavior through the public interface.
3. Run the focused file first: `node --test tests/<area>.test.ts`. Filter one test with `node --test --test-name-pattern="<name>" tests/<area>.test.ts`.
4. Run the closing gates CI runs: `node --test tests/`, `tsc --noEmit`, `biome ci` and, for packaging changes, `npm pack --dry-run`.
5. Record exact commands, results, environmental limits and skipped gates. Documentation-only work needs proportionate structural checks, not invented test evidence.

## Output Contract

Report the area, files changed, focused command and result, closing gate commands and results, and anything skipped or blocked. Never present a single-file run as the full suite.

## References

Paths below are repository-relative.

- `tests/`: test files and shared fakes
- `CONTRIBUTING.md`: local checks and privacy rules
- `.github/workflows/`: the gates CI runs
