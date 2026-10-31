import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';

import type { Page } from './fixtures.ts';
import { expect } from './fixtures.ts';
import { pageRequest, waitForRuntimeReady } from './helpers.ts';

export type RendererSurface = keyof RendererPerformanceScenarioDiagnostic['react']['surfaces'];

/**
 * Server Core replacements Desktop's supervisor allows in quick succession (`defaultServerSupervisionPolicy`).
 */
export const SERVER_RESTART_BUDGET = 3;

/**
 * What one Session switch to the Chat looked like, frame by frame from the click. Times are milliseconds from the
 * click; a field is `null` when the state never appeared.
 */
export interface ChatSwitchSample {
    /**
     * The first frame that showed the target Session.
     */
    shownMs: number | null;
    /**
     * The first frame that drew the transcript's placeholder turns.
     */
    placeholderMs: number | null;
    /**
     * The first frame that drew the real turns with no placeholder left.
     */
    contentMs: number | null;
    /**
     * The first frame in which the target Session's Message composer held keyboard focus, so typing goes to the Chat.
     */
    interactiveMs: number | null;
    /**
     * Frames that showed the Session with neither placeholder nor turns: what the user sees as a blank transcript.
     */
    blankFrames: number;
    /**
     * Longest gap between two sampled frames, the main-thread block the user sees as the switch freezing.
     */
    maxFrameGapMs: number;
    /**
     * `scroll` events the transcript fired from the click on, when it existed before the click.
     */
    scrollEvents: number;
    /**
     * The transcript's distance from its end before the click and in the first frame that showed its content.
     */
    distanceFromEndBefore: number | null;
    distanceFromEndAfter: number | null;
    /**
     * The farthest from its end the transcript was painted over the frames after its content first showed: a Chat left
     * following its latest reply that comes back anywhere else is seen jumping down to it.
     */
    maxDistanceFromEndSettling: number | null;
    /**
     * `agentChat.read` requests Server Core answered for the switch.
     */
    readRequests: number;
    /**
     * The Renderer build the scenario ran in. React counts are real only in a `profiling` build with the Profiler
     * `available`.
     */
    buildMode: RendererPerformanceScenarioDiagnostic['buildMode'];
    reactProfiler: RendererPerformanceScenarioDiagnostic['capabilities']['reactProfiler'];
    /**
     * React work from the click to the end of the settling frames, from the Renderer's own `session.switch` scenario:
     * commits, and per surface the Profiler renders and their summed actual duration.
     */
    react: {
        commitCount: number;
        surfaces: Record<RendererSurface, { renders: number; actualDurationMs: number }>;
    };
    /**
     * The longest Long Animation Frame Chromium reported in the same window, or `0` when it reported none.
     */
    longestAnimationFrameMs: number;
}

/**
 * Counts distinct `agentChat.read` requests in Server Core's log. A request from the Renderer is recorded twice, once
 * where the control relay admits it and once where its domain answers it, and both records carry its `requestId`.
 */
export async function countChatReads(userData: string): Promise<number> {
    let contents: string;
    try {
        contents = await readFile(join(userData, 'logs', 'server-core.jsonl'), 'utf8');
    } catch {
        return 0;
    }
    const requests = contents
        .split('\n')
        .filter(Boolean)
        .map(
            (line) =>
                JSON.parse(line) as {
                    event?: string;
                    correlationId?: string;
                    context?: { requestId?: string };
                    fields?: { method?: string };
                },
        )
        .filter(
            (record) =>
                record.event === 'ipc.request' && record.fields?.method === 'agentChat.read',
        )
        .map((record) => record.context?.requestId ?? record.correlationId);
    return new Set(requests).size;
}

/**
 * The 50th and 95th nearest-rank percentiles and the maximum of one measured quantity across a scenario's switches.
 */
interface Distribution {
    p50: number;
    p95: number;
    max: number;
}

/**
 * One scenario's switches reduced to stable receipt paths (`scenarios.cached.readableMs.p50`), which
 * `scripts/performance-baseline.ts` flattens into baseline metrics. `readableMs` is the sample's `contentMs`: the first
 * frame that drew the real turns. A sample that never reached a state is left out of that distribution; the invariants
 * reject such a run anyway.
 */
export interface ChatSwitchSummary {
    iterations: number;
    readableMs: Distribution;
    interactiveMs: Distribution;
    shownMs: Distribution;
    maxFrameGapMs: Distribution;
    longestAnimationFrameMs: Distribution;
    readRequests: Distribution;
    react: {
        commitCount: Distribution;
        surfaces: Record<
            RendererSurface,
            { renders: Distribution; actualDurationMs: Distribution }
        >;
    };
}

function distribution(values: ReadonlyArray<number | null>): Distribution {
    const sorted = values
        .filter((value): value is number => value !== null)
        .toSorted((left, right) => left - right);
    if (sorted.length === 0) return { p50: NaN, p95: NaN, max: NaN };
    const rank = (percentile: number) =>
        sorted[Math.min(sorted.length - 1, Math.ceil((percentile / 100) * sorted.length) - 1)];
    return { p50: rank(50), p95: rank(95), max: sorted.at(-1)! };
}

export function summarize(samples: readonly ChatSwitchSample[]): ChatSwitchSummary {
    const surface = (name: RendererSurface) => ({
        renders: distribution(samples.map((sample) => sample.react.surfaces[name].renders)),
        actualDurationMs: distribution(
            samples.map((sample) => sample.react.surfaces[name].actualDurationMs),
        ),
    });
    return {
        iterations: samples.length,
        readableMs: distribution(samples.map((sample) => sample.contentMs)),
        interactiveMs: distribution(samples.map((sample) => sample.interactiveMs)),
        shownMs: distribution(samples.map((sample) => sample.shownMs)),
        maxFrameGapMs: distribution(samples.map((sample) => sample.maxFrameGapMs)),
        longestAnimationFrameMs: distribution(
            samples.map((sample) => sample.longestAnimationFrameMs),
        ),
        readRequests: distribution(samples.map((sample) => sample.readRequests)),
        react: {
            commitCount: distribution(samples.map((sample) => sample.react.commitCount)),
            surfaces: {
                'primary-sidebar': surface('primary-sidebar'),
                'workbench': surface('workbench'),
                'secondary-sidebar': surface('secondary-sidebar'),
            },
        },
    };
}

/**
 * Kills Server Core and waits for Desktop to replace it, so the next `agentChat.read` finds no provider running and the
 * Chat's thread must be resumed (`docs/agent-chat.md` "Lazy start").
 */
export async function restartServerCore(page: Page): Promise<void> {
    const before = await pageRequest<{ pid: number }>(page, 'host.status');
    process.kill(before.pid, 'SIGKILL');
    /**
     * A request sent while no Server is connected fails, which reads as not replaced yet.
     */
    const isServerReplaced = async () => {
        try {
            const { pid } = await pageRequest<{ pid: number }>(page, 'host.status');
            return pid !== before.pid;
        } catch {
            return false;
        }
    };
    await expect.poll(isServerReplaced, { timeout: 30_000 }).toBe(true);
    await waitForRuntimeReady(page);
}
