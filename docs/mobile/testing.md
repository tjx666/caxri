---
kind: living
status: current
---

# Mobile Flows and Device Benchmarks

Two Android commands sit between unit tests and the Android Acceptance round. They run against an
already installed build on a disposable emulator and need no report round, Desktop fixture, or
account.

| Command                                       | Purpose                                                |
| --------------------------------------------- | ------------------------------------------------------ |
| `bun run --cwd apps/mobile android:flows`     | Regression flows written as Maestro YAML               |
| `bun run --cwd apps/mobile android:benchmark` | Frame rate, CPU, and RAM of one flow over N iterations |

Acceptance (`bun run test:e2e:mobile:android`) still owns report-bound evidence; these commands
are for checking a change quickly. Competitor drivers and metrics are compared in
[mobile-testing.md](../../.agents/skills/competitors/references/mobile-testing.md).

## Setup

Both commands take an explicit `--serial emulator-<port>` and refuse anything else, because flows
clear app data. Build and install a release APK first:

```sh
bun run --cwd apps/mobile prebuild:android -- --clean
bun run --cwd apps/mobile android -- --build-only --variant release --abi arm64-v8a
adb -s emulator-5742 install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

The driver is [agent-device](https://github.com/callstack/agent-device), an `apps/mobile`
devDependency, following Paseo's phone test setup; it needs no Java and no account. Its device claims keep parallel worktrees off each
other's emulators. To explore a screen before writing a flow, run it directly, for example
`bun run --cwd apps/mobile agent-device snapshot -i --platform android --serial emulator-5742`.

## Flows

`apps/mobile/flows/*.yaml` use the Maestro YAML subset agent-device supports and select elements by
`testID`. They stay portable to the Maestro CLI.

```sh
bun run --cwd apps/mobile android:flows --serial emulator-5742            # every flow
bun run --cwd apps/mobile android:flows --serial emulator-5742 launch-to-pairing
```

The command exits non-zero when any flow fails. Current flows cover the unpaired app only: cold launch
to the pairing entry screen, and the paste method round trip. Flows that need a paired Session wait for
a reusable pairing fixture.

## Benchmark

`android:benchmark` clears app data, then runs one flow repeatedly under the Flashlight profiler
(`@perf-profiler/e2e`), which samples FPS, per-thread CPU, and RAM on the device every 500 ms:

```sh
bun run --cwd apps/mobile android:benchmark --serial emulator-5742 \
  --flow launch-to-pairing --iterations 5
```

Flashlight issues bare `adb` commands, so the script sets `ANDROID_SERIAL` to pin them to the selected
emulator, and puts the SDK's `adb` on `PATH`. Android's `gfxinfo` jank counters are not used: agent-device
stops the app when a flow ends, so they are gone before they can be read. The receipt lands in `test-results/receipts/mobile-android-benchmark-<flow>.json` with per
iteration and median values. The command exits non-zero when any iteration failed, because the median then
rests on fewer samples than requested:

| Field                   | Meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `medianAverageFps`      | Median of each run's average sampled FPS                           |
| `worstMinimumFps`       | Lowest FPS sample after the first frame across all runs            |
| `medianTotalCpuPercent` | Median of the summed per-thread CPU; above 100 means several cores |
| `peakRamMb`             | Highest RAM sample across all runs                                 |
| `medianRunTimeMs`       | Median flow duration, including agent-device driver overhead       |
| `debuggable`            | Whether the installed build is debuggable; compare only `false`    |
| `failedIterations`      | Iterations Flashlight retried after a flow failure                 |

A static screen draws no frames, so FPS falls to 0 while nothing moves. Read `worstMinimumFps` only for
flows that keep the screen moving, such as scrolling or a streaming reply; on the current pairing flows it
reaches 0 whenever the screen rests.

Baseline on 2026-10-31: Pixel 8 AVD (API 36, arm64) on a host running seven other emulators, release
build, `launch-to-pairing`, five iterations: median 49.6 FPS, 28.3% total CPU, 230.8 MB peak RAM,
12.9 s run time (driver-dominated; runs ranged 9.7 to 24.4 s).

The receipt holds only numbers, the flow name, package, and serial. Emulator numbers compare two
builds on the same host; they are not physical-device budgets, which
[performance.md](performance.md#release-budgets) owns.
