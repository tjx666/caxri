import process from 'node:process';

import type { RendererSurface } from './agent-chat-switch-samples.ts';

/**
 * Hard ceilings on the p50 time from the click until the conversation is readable, from issue #2215: a kept-alive Chat
 * within 100 ms, a Chat whose provider must start and resume its thread after a Server Core restart within one second.
 * The runner-derived baseline (`scripts/performance-baseline.agent-chat-switch.json`) is the tighter, statistical gate;
 * these only catch a switch that became unusably slow.
 */
const LOCAL_READABLE_P50_CEILING_MS = { keptAlive: 100, cold: 1000 };
/**
 * Whether this run is on a disposable GitHub-hosted runner (`CAXRI_E2E_RUNNER_KIND`, set by the `e2e-perf` job in
 * `ci.yml` and by `performance-samples.yml`). The fixed budgets in this file were calibrated on a fast local machine,
 * and the hosted `macos-15` image is up to four times slower on the React durations and the Server Core restart, so the
 * same budgets failed every hosted run.
 */
const IS_GITHUB_HOSTED = process.env.CAXRI_E2E_RUNNER_KIND === 'github-hosted';
/**
 * Hosted-runner counterpart of {@link LOCAL_READABLE_P50_CEILING_MS}. Observed on 44 hosted receipts
 * (performance-samples runs 41245949323 and 41250478424, one `macos-15` runner per receipt): the kept-alive p50 peaked
 * at 76 ms, which the 100 ms ceiling already covers, and the cold p50 had a 278 ms median and a 1,083 ms maximum, so
 * the cold ceiling is about 1.5 times that maximum. These are catastrophic guards; the committed statistical baseline
 * (`scripts/performance-baseline.agent-chat-switch.json`) is what catches creep.
 */
const HOSTED_READABLE_P50_CEILING_MS = { keptAlive: 100, cold: 1650 };
export const READABLE_P50_CEILING_MS = IS_GITHUB_HOSTED
    ? HOSTED_READABLE_P50_CEILING_MS
    : LOCAL_READABLE_P50_CEILING_MS;
/**
 * Longest frame gap and Long Animation Frame a remount of a cached Chat may show. Mounting the whole timeline in one
 * frame measured 82-104 ms and 77-99 ms on 2026-10-30; mounting the tail first measured 36-48 ms and none. The budget
 * sits between them with room for runner noise; it is not the 34 ms (two frames) the experience aims for.
 */
const LOCAL_CACHED_FRAME_BUDGET = { maxFrameGapMs: 65, longestAnimationFrameMs: 50 };
/**
 * Hosted-runner counterpart of {@link LOCAL_CACHED_FRAME_BUDGET}. The 44 hosted receipts had a cached p50 frame gap of
 * 57 ms median and 86 ms maximum, and a p50 Long Animation Frame of 55 ms median and 84 ms maximum, so the local budget
 * failed most hosted runs. Both ceilings are about 1.5 times the observed maximum: they only catch a remount that got
 * far worse than any hosted run has shown. The local budget keeps guarding the tail-first mount.
 */
const HOSTED_CACHED_FRAME_BUDGET = { maxFrameGapMs: 130, longestAnimationFrameMs: 130 };
export const CACHED_FRAME_BUDGET = IS_GITHUB_HOSTED
    ? HOSTED_CACHED_FRAME_BUDGET
    : LOCAL_CACHED_FRAME_BUDGET;
export type ChatSwitchScenario = 'keptAlive' | 'cached' | 'uncached' | 'cold';

/**
 * Per-surface React budgets, calibrated from three profiling runs on 2026-10-20 (`docs/renderer-performance.md`). The
 * kept-alive Workbench budget is the one that guards the experience: a switch back to a mounted Chat that renders its
 * transcript again costs about as much as the `cached` remount.
 */
/*
 * The Workbench render budgets of `cached` and `uncached` count the idle backfill of the tail-first mount
 * (`use-agent-chat-tail-first-mount.ts`): a 16-turn Chat mounts 4 entries, then 6 more per idle commit, and each commit
 * renders the pane tree a few times. That trades a few more renders for a short first frame (82-104 ms down to 36-48 ms
 * on 2026-10-30). Measured 24-25 cached and 27-30 uncached on a quiet runner; the budgets leave about 20% for noise.
 * Renders before the tail-first mount were 9-10 and 17-20. Duration budgets are unchanged and still bound the total cost.
 */
export const REACT_BUDGETS: Record<
    ChatSwitchScenario,
    Record<RendererSurface, { renders: number; actualDurationMs: number }>
> = {
    keptAlive: {
        'primary-sidebar': { renders: 4, actualDurationMs: 5 },
        'workbench': { renders: 8, actualDurationMs: 5 },
        'secondary-sidebar': { renders: 8, actualDurationMs: 5 },
    },
    cached: {
        'primary-sidebar': { renders: 4, actualDurationMs: 5 },
        'workbench': { renders: 30, actualDurationMs: 60 },
        'secondary-sidebar': { renders: 8, actualDurationMs: 5 },
    },
    uncached: {
        'primary-sidebar': { renders: 4, actualDurationMs: 5 },
        'workbench': { renders: 36, actualDurationMs: 90 },
        'secondary-sidebar': { renders: 10, actualDurationMs: 5 },
    },
    cold: {
        'primary-sidebar': { renders: 4, actualDurationMs: 5 },
        'workbench': { renders: 36, actualDurationMs: 90 },
        'secondary-sidebar': { renders: 10, actualDurationMs: 5 },
    },
};

/**
 * Hosted-runner overrides of {@link REACT_BUDGETS}, only where the local budget is below what hosted runners measure.
 * Each duration is about 1.5 times the largest per-receipt p50 seen across 44 hosted receipts (performance-samples runs
 * 41245949323 and 41250478424): cached Workbench 76.4 ms, uncached Workbench 171.5 ms, cold Workbench 346.4 ms, cold
 * primary sidebar 22.5 ms, cold secondary sidebar 10.3 ms. The kept-alive Workbench peaked at 3.8 ms against its 5 ms
 * budget, too little headroom for one noisy runner, so it gets 8 ms; its render budget still catches a re-rendered
 * transcript. Render counts did not vary with the runner except one: the cold primary sidebar rendered 5 times in 3 of
 * the 44 receipts (median 4), so it gets 5. These are catastrophic guards; the committed baseline catches creep.
 */
const HOSTED_REACT_BUDGET_OVERRIDES: Partial<
    Record<
        ChatSwitchScenario,
        Partial<Record<RendererSurface, Partial<{ renders: number; actualDurationMs: number }>>>
    >
> = {
    keptAlive: { workbench: { actualDurationMs: 8 } },
    cached: { workbench: { actualDurationMs: 115 } },
    uncached: { workbench: { actualDurationMs: 260 } },
    cold: {
        'primary-sidebar': { renders: 5, actualDurationMs: 35 },
        'workbench': { actualDurationMs: 520 },
        'secondary-sidebar': { actualDurationMs: 16 },
    },
};

/**
 * The renders and p50 React duration a surface may spend in a scenario on this runner.
 */
export function reactBudget(
    scenario: ChatSwitchScenario,
    surface: RendererSurface,
): { renders: number; actualDurationMs: number } {
    const local = REACT_BUDGETS[scenario][surface];
    const hosted = IS_GITHUB_HOSTED
        ? HOSTED_REACT_BUDGET_OVERRIDES[scenario]?.[surface]
        : undefined;
    return { ...local, ...hosted };
}
