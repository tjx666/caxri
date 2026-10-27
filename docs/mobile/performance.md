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

## Release gate still required

Before distribution:

1. Build the release profile without Metro or Expo development-client UI.
2. Add app-owned timing from process/runtime start through the first committed pairing or Session
   surface; do not infer interaction readiness from UIAutomator latency.
3. Run three same-build samples per platform and compare medians and worst runs against the fixed
   budgets.
4. Investigate a component only when three exact-build runs reproduce the same regression.
