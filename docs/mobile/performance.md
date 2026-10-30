---
kind: living
status: current
---

# Mobile Performance Baseline

## Release budgets

The phase-one targets are:

| Metric                    |   Budget |
| ------------------------- | -------: |
| Cold start                | 2,500 ms |
| Warm start                |   900 ms |
| First interactive screen  | 1,500 ms |
| Dropped/janky frame ratio |       3% |

`apps/mobile/src/features/performance/performance-budget.ts` owns these fixed thresholds. They must be
enforced only against a release build with app-owned first-interactive instrumentation. Browser or
device-driver observations remain diagnostic until repeated runs on the same runner prove a stable
measurement.

## Development-client sampler

Authenticated frames update a ref-backed last-observation timestamp without publishing a new
shared React context. The Sessions screen samples it once a second, so the Connection banner still
appears within about a second of the five-second stale threshold, but it re-renders only when a
sample changes what it shows: freshness flips at once, and the time Session ages are measured against
moves in 15-second steps (`nextConnectionClock` in
`apps/mobile/src/features/connection/connection-state.ts`, covered by its unit test). An idle,
connected Sessions screen therefore renders about four times a minute instead of every second, and
the Session detail, which never reads the clock, is memoized so those renders stop at it.
Connection status changes still propagate immediately. This is a render-count contract, not a device
frame-rate or release-performance claim.

Run from the repository root with one explicit ADB serial and one stable ready `testID`:

```sh
bun run --cwd apps/mobile android:performance \
  --serial emulator-5554 \
  --ready-check-id session-list
```

The script verifies the package, resets Android graphics counters, measures a force-stopped launch and
a foreground resume, and waits for the requested semantic identifier. It preserves app data and leaves
Caxri in the foreground. Its JSON receipt contains no visible text, source, Terminal output, Agent
transcripts, credentials, or environment values.

`activity.totalTimeMs` is Android's cold Activity launch time. Android omits that field when an existing
task is only brought to the foreground, so the warm receipt retains `waitTimeMs`. The semantic readiness
value is named `readyCheckUpperBoundMs` because UIAutomator tree capture adds substantial observer time.

## Phase-one diagnostic baseline

Environment: Pixel 8 AVD, Android 16 / API 36, ARM64, Expo development client, local Metro, paired
Session list. Three consecutive runs used the same working tree on 2026-08-31.

| Run    | Cold Activity | Warm wait | Cold ready upper bound | Warm ready upper bound | Cold jank | Warm jank |
| ------ | ------------: | --------: | ---------------------: | ---------------------: | --------: | --------: |
| 1      |      2,470 ms |     25 ms |               6,017 ms |               6,184 ms |    19.48% |    17.81% |
| 2      |      1,759 ms |     31 ms |               7,423 ms |               6,471 ms |    13.89% |    17.33% |
| 3      |      2,786 ms |     10 ms |               6,405 ms |               6,806 ms |    17.57% |    18.92% |
| Median |      2,470 ms |     25 ms |               6,405 ms |               6,471 ms |    17.57% |    17.81% |

The cold Activity launch exceeded the target once in three runs. Ready detection and frame ratios are
dominated by the Expo development shell, JavaScript loading, emulator scheduling, and UIAutomator
observation; they identify the startup path as the first release-performance checkpoint but cannot
attribute cost to a production component.

## Relay reconnect latency

`bun run benchmark:relay-link` (`scripts/relay-link-benchmark.ts`) runs the real Relay, a
`MobileGateway` with canned replies, and the phone's own connection code from `apps/mobile` in one
process. Two shaped TCP proxies (`scripts/link-shaping.ts`) sit in front of the Relay, one for the
phone's leg and one for the computer's, each adding its round trip and its TCP plus TLS setup. The
phone's stored LAN address points at a listener that never answers, the way a home address behaves
away from home. Each profile starts with no route memory, so its first round (`cold readyMs`) pays the
full direct-route grace; the median covers the later rounds. E is one phone-to-computer round trip
through the Relay.

| Metric             | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `readyMs`          | Reconnect until the encrypted session is ready                       |
| `firstDashboardMs` | Reconnect until the first Session list snapshot arrived              |
| `sessionOpenMs`    | Opening a Session (changes and Chat subscriptions) until Chat loaded |

Medians of five warm rounds on 2026-10-30, before and after the route memory and pipelined
subscribe-and-read changes. `sg-proxy` matches a phone reaching a Singapore Relay through a proxy
(phone leg 90 ms, computer leg 60 ms); `cn-direct` matches a mainland direct connection (230 ms).

| Profile     |   E | `readyMs` before → after | `firstDashboardMs` before → after | `sessionOpenMs` before → after |
| ----------- | --: | -----------------------: | --------------------------------: | -----------------------------: |
| `local`     |   0 |              2,527 → 332 |                       2,539 → 339 |                         16 → 7 |
| `sg-proxy`  | 150 |            3,413 → 1,222 |                     3,717 → 1,379 |                      458 → 157 |
| `cn-direct` | 290 |            4,256 → 2,055 |                     4,843 → 2,353 |                      878 → 294 |

The cold round still paid the 2.5 second grace (3,422 ms on `sg-proxy`) unless the phone was on
cellular data.

Medians of five warm rounds on 2026-10-31, after the Relay socket opens with the direct race, the
Server keeps a standby socket parked at the Relay, the reconnect `hello` rides behind
`relay-connect`, and the first requests ride behind the handshake confirmation:

| Profile     |   E | cold `readyMs` | `readyMs` | `firstDashboardMs` | `sessionOpenMs` |
| ----------- | --: | -------------: | --------: | -----------------: | --------------: |
| `local`     |   0 |          2,510 |       311 |                320 |               7 |
| `sg-proxy`  | 150 |          2,656 |       460 |                615 |             156 |
| `cn-direct` | 290 |          2,799 |       988 |              1,283 |             294 |

A warm reconnect now costs about three Relay round trips (E): the phone's TLS setup to the Relay, the
`hello` and challenge, and the confirmation and `ready`. The cold round still waits out the grace,
but the Relay socket's TLS setup now overlaps it.

## Release gate still required

Before distribution:

1. Build the release profile without Metro or Expo development-client UI.
2. Add app-owned timing from process/runtime start through the first committed pairing or Session
   surface; do not infer interaction readiness from UIAutomator latency.
3. Run three same-build samples per platform and compare medians and worst runs against the fixed
   budgets.
4. Investigate a component only when three exact-build runs reproduce the same regression.
