# Mobile E2E and benchmarks

_Researched 2026-10-31 from local clones (Paseo `5dc3500`, Orca `47018d484`, T3 Code `96fc7b955`) and public
docs (agent-device, Flashlight). Caxri's resulting tooling is
[docs/mobile/testing.md](../../../../docs/mobile/testing.md)._

How competing phone clients drive their apps in tests and what they measure. Read it before adding
a mobile flow, a mobile benchmark, or a connection test.

## Drivers

| Product | Driver                                                                                            | Notes                                                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paseo   | Callstack [agent-device](https://github.com/callstack/agent-device) `.ad` scripts, Maestro YAML   | `competitors/paseo/docs/mobile-testing.md`: `.ad` is the primary format; older `packages/app/maestro/*.yaml` flows replay through `agent-device replay --maestro`. Bespoke `.mjs` harnesses compare bounds when accessibility state cannot prove layout (keyboard, autocomplete). |
| Orca    | Vitest units plus a standalone E2EE mock desktop (competitors/orca/mobile/scripts/mock-server.ts) | The mock serves fake RPC data, scaled by environment variables (competitors/orca/mobile/scripts/mobile-lag-scenario.ts: N repos, worktrees, agents), so lag repros run without a real desktop.                                                                                    |
| T3 Code | Hand-written device journey (`competitors/t3code/scripts/mobile-e2e/`) with video capture         | Used for showcase recordings rather than a regression suite.                                                                                                                                                                                                                      |

agent-device is built for coding agents: accessibility snapshots with refs, deterministic replay,
device claims that keep parallel worktrees off each other's devices, and `perf frames`,
`perf memory`, Perfetto, and `react-devtools profile` for render counts. It runs a documented,
fail-loud subset of Maestro YAML, so flows stay portable to the Maestro CLI.

## What competitors measure

| Concern                        | Who               | How                                                                                                                                                                                                                                      |
| ------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Streaming output latency       | Paseo             | competitors/paseo/scripts/benchmark-terminal-latency.ts: isolated daemon, echo latency p50/p95, 2 MB burst jitter and snapshot fallbacks under mock-agent load (`competitors/paseo/docs/terminal-performance.md`).                       |
| Keystroke to render            | Paseo             | Browser specs measure keydown to xterm commit per stage under a 600-key burst.                                                                                                                                                           |
| Relay round trip               | Paseo             | competitors/paseo/scripts/measure-relay-latency.ts: warm-up then 20 pings each over direct and Relay connections, with server-side timestamps.                                                                                           |
| Relay to direct route switch   | Paseo             | `competitors/paseo/packages/app/maestro/relay-then-direct.yaml`: pair over Relay, add a direct host, assert the app prefers direct.                                                                                                      |
| Large-list lag                 | Orca              | Mock server scenario sized by environment variables reproduces a slow phone dashboard.                                                                                                                                                   |
| Transfer budget                | T3 Code           | competitors/t3code/apps/server/integration/transferBudgetV2.integration.test.ts caps decoded bytes and rows of a cold snapshot and one history page for a 900-row turn (`competitors/t3code/docs/internals/performance-regressions.md`). |
| Frame rate, CPU, RAM on device | none of the above | No competitor runs Flashlight or Macrobenchmark against its phone build.                                                                                                                                                                 |

No competitor publishes a device-level benchmark for a streaming chat list; they bound the wire
(T3 Code), the server pipeline (Paseo), or reproduce lag with synthetic scale (Orca).

## Gaps this suggests for Caxri

Caxri already covers reconnect latency (`benchmark:relay-link`). Missing, in priority order:

1. Streaming Chat on the device: frame drops and React commit counts while a long reply streams
   into a long Session. Needs a paired fixture (the Android Acceptance fixture) plus
   `android:benchmark` and agent-device `react-devtools profile`.
2. Transfer budget: bytes and rows of a Session's first Chat page and one older page, in the style of
   T3 Code's integration test.
3. Connection stability: scripted network drops (`svc wifi disable`, Relay restart) counting
   reconnect attempts and time to ready, like Paseo's relay-then-direct flow.
4. Large-scale lists: a synthetic Project with many Sessions, like Orca's lag scenario.
