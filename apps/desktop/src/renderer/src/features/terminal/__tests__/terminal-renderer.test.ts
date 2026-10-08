import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGpuIncidentBudget } from '../../gpu/gpu-incident-budget';
import type { TerminalRendererStatus } from '../terminal-renderer';
import {
    resolveTerminalRendererTarget,
    TerminalRendererController,
    terminalWebglRetryDelayMs,
} from '../terminal-renderer';
import type { TerminalWebglSessionPolicy } from '../terminal-webgl-session-policy';
import { isWebgl2Available } from '../terminal-webgl-session-policy';
import { createPolicy, FakeWebglAddon } from './terminal-renderer-test-helpers';

describe('manual GPU retry', () => {
    it('recovers a pinned pane without changing its preference and protects again after new incidents', () => {
        const policy = createGpuIncidentBudget({ probeWebgl2: () => true });
        policy.applyPreference('on');
        for (let index = 0; index < 3; index++) policy.recordIncident(`before-${index}`);
        const harness = createHarness({ policy });
        harness.controller.setPreference('on');
        expect(harness.statuses.at(-1)?.reason).toBe('context-loss-limit');

        expect(harness.controller.retryFromUser()).toBe(true);
        expect(harness.statuses.at(-1)?.mode).toBe('webgl');
        expect(policy.isPinnedToDom()).toBe(false);
        for (let index = 0; index < 3; index++) policy.recordIncident(`after-${index}`);
        harness.controller.recoverFromGpuProcessLoss();
        expect(harness.statuses.at(-1)?.reason).toBe('context-loss-limit');
        harness.controller.dispose();
    });

    it('makes one attempt on failure and never rearms an automatic retry loop', () => {
        vi.useFakeTimers();
        const harness = createHarness({ loadError: new Error('GPU unavailable') });
        harness.controller.setPreference('on');
        expect(harness.controller.retryFromUser()).toBe(false);
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'dom', retryState: 'exhausted' });
        const attempts = harness.host.loadAddon.mock.calls.length;
        vi.runAllTimers();
        expect(harness.host.loadAddon).toHaveBeenCalledTimes(attempts);
        harness.controller.dispose();
        vi.useRealTimers();
    });

    it('does not revive disposed panes or override a preference switched off during confirmation', () => {
        const harness = createHarness();
        harness.controller.setPreference('off');
        expect(harness.controller.retryFromUser()).toBe(false);
        harness.controller.dispose();
        expect(harness.controller.retryFromUser()).toBe(false);
        expect(harness.host.loadAddon).not.toHaveBeenCalled();
    });
});

function createHarness(
    options: {
        canRetry?: () => boolean;
        loadError?: Error;
        loadFailures?: number[];
        policy?: TerminalWebglSessionPolicy;
        random?: () => number;
        supported?: boolean;
    } = {},
) {
    const addons: FakeWebglAddon[] = [];
    const statuses: TerminalRendererStatus[] = [];
    let loadAttempt = 0;
    const host = {
        loadAddon: vi.fn((candidate: ITerminalAddon) => {
            loadAttempt += 1;
            if (options.loadError || options.loadFailures?.includes(loadAttempt))
                throw options.loadError ?? new Error(`WebGL load ${loadAttempt} failed`);
            candidate.activate({} as Terminal);
        }),
    };
    const redraw = vi.fn();
    const controller = new TerminalRendererController(
        host,
        redraw,
        (status) => {
            statuses.push(status);
        },
        {
            canRetryWebgl: options.canRetry ?? (() => true),
            createWebglAddon: () => {
                const addon = new FakeWebglAddon();
                addons.push(addon);
                return addon;
            },
            policy: options.policy ?? createPolicy({ supported: options.supported }),
            // The midpoint of the jitter range makes every delay equal to its exponential base.
            random: options.random ?? (() => 0.5),
        },
    );
    return {
        get addon() {
            return addons[0];
        },
        addons,
        controller,
        host,
        redraw,
        statuses,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('TerminalRendererController', () => {
    it('probes a real WebGL2 context and releases it immediately', () => {
        const loseContext = vi.fn();
        const getExtension = vi.fn(() => ({ loseContext }));
        const getContext = vi.fn(() => ({ getExtension }));
        const createElement = vi.fn(() => ({ getContext }));
        vi.stubGlobal('document', { createElement });

        try {
            expect(isWebgl2Available()).toBe(true);
            expect(createElement).toHaveBeenCalledWith('canvas');
            expect(getContext).toHaveBeenCalledWith('webgl2');
            expect(getExtension).toHaveBeenCalledWith('WEBGL_lose_context');
            expect(loseContext).toHaveBeenCalledOnce();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('reports WebGL2 unavailable when Chromium cannot create a context', () => {
        const getContext = vi.fn(() => null);
        vi.stubGlobal('document', { createElement: vi.fn(() => ({ getContext })) });

        try {
            expect(isWebgl2Available()).toBe(false);
            expect(getContext).toHaveBeenCalledWith('webgl2');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('uses a deterministic Auto rule and keeps Off on DOM', () => {
        expect(resolveTerminalRendererTarget('off', true)).toBe('dom');
        expect(resolveTerminalRendererTarget('auto', false)).toBe('dom');
        expect(resolveTerminalRendererTarget('auto', true)).toBe('webgl');
        expect(resolveTerminalRendererTarget('on', false)).toBe('dom');

        const harness = createHarness();
        harness.controller.setPreference('off');
        expect(harness.host.loadAddon).not.toHaveBeenCalled();
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'dom', reason: 'disabled' });
    });

    it('keeps On on DOM when a real WebGL2 context is unavailable', () => {
        const harness = createHarness({ supported: false });

        harness.controller.setPreference('on');

        expect(harness.host.loadAddon).not.toHaveBeenCalled();
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'dom', reason: 'unsupported' });
    });

    it('enables WebGL and hot-disables it with a full DOM redraw', () => {
        const harness = createHarness();
        harness.controller.setPreference('on');
        expect(harness.host.loadAddon).toHaveBeenCalledWith(harness.addon);
        expect(harness.redraw).toHaveBeenLastCalledWith('grid-sync');
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'webgl', reason: 'active' });

        harness.redraw.mockClear();
        harness.controller.setPreference('off');
        expect(harness.addon.dispose).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledWith('grid-sync');
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'dom', reason: 'disabled' });
    });

    it('fails closed when WebGL activation is unavailable', () => {
        const harness = createHarness({ loadError: new Error('GPU unavailable') });
        harness.controller.setPreference('on');

        expect(harness.addon.dispose).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledWith('grid-sync');
        expect(harness.statuses.at(-1)).toMatchObject({
            contextLossCount: 0,
            mode: 'dom',
            reason: 'load-failed',
            trigger: 'webgl-load-failed',
        });
    });

    it('falls back on context loss without reloading the addon or touching another lifecycle', () => {
        const harness = createHarness();
        harness.controller.setPreference('on');
        harness.redraw.mockClear();
        harness.addon.loseContext();

        expect(harness.host.loadAddon).toHaveBeenCalledTimes(1);
        expect(harness.addon.dispose).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledWith('grid-sync');
        expect(harness.statuses.at(-1)).toMatchObject({
            contextLossCount: 1,
            mode: 'dom',
            reason: 'context-loss',
            trigger: 'webgl-context-loss',
        });
    });

    it('retries WebGL after a transient context loss without changing the preference', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        harness.controller.setPreference('on');

        harness.addon.loseContext();
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'context-loss',
            retryState: 'scheduled',
        });

        await vi.advanceTimersByTimeAsync(1_000);

        expect(harness.host.loadAddon).toHaveBeenCalledTimes(2);
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'webgl',
            reason: 'active',
            retryAttemptCount: 1,
            retryState: 'succeeded',
            trigger: 'webgl-retry-succeeded',
        });
    });

    it('recovers on a later attempt when the GPU process returns during the backoff', async () => {
        vi.useFakeTimers();
        // The session budget owns the probe cache; the first retry lands while the GPU is still relaunching.
        const probeWebgl2 = vi.fn(() => false);
        const budget = createGpuIncidentBudget({ probeWebgl2 });
        const harness = createHarness({ policy: budget });
        probeWebgl2.mockReturnValueOnce(true);
        harness.controller.setPreference('on');
        budget.recordIncident('incident-1');

        harness.addon.loseContext();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'load-failed',
            retryAttemptCount: 1,
            trigger: 'webgl-retry-scheduled',
        });

        probeWebgl2.mockReturnValue(true);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(harness.host.loadAddon).toHaveBeenCalledTimes(2);
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'webgl',
            reason: 'active',
            retryAttemptCount: 2,
            retryState: 'succeeded',
            trigger: 'webgl-retry-succeeded',
        });
    });

    it('stops after three failed retry attempts in one rolling window', async () => {
        vi.useFakeTimers();
        const harness = createHarness({ loadFailures: [2, 3, 4] });
        harness.controller.setPreference('on');

        harness.addon.loseContext();
        // Exponential base delays: 1 s, 2 s, 4 s.
        await vi.advanceTimersByTimeAsync(7_000);

        expect(harness.host.loadAddon).toHaveBeenCalledTimes(4);
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'load-failed',
            retryAttemptCount: 3,
            retryDelayMs: null,
            retryLimit: 3,
            retryState: 'exhausted',
            trigger: 'webgl-retry-exhausted',
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.host.loadAddon).toHaveBeenCalledTimes(4);
    });

    it('backs off exponentially with jitter between retry attempts', async () => {
        vi.useFakeTimers();
        const randoms = [0.25, 1, 0];
        const harness = createHarness({
            loadFailures: [2, 3, 4],
            random: () => randoms.shift() ?? 0.5,
        });
        harness.controller.setPreference('on');

        harness.addon.loseContext();
        expect(harness.statuses.at(-1)).toMatchObject({
            retryDelayMs: 750,
            retryState: 'scheduled',
        });
        await vi.advanceTimersByTimeAsync(750);
        expect(harness.statuses.at(-1)).toMatchObject({
            retryAttemptCount: 1,
            retryDelayMs: 3_000,
            trigger: 'webgl-retry-scheduled',
        });
        await vi.advanceTimersByTimeAsync(3_000);
        expect(harness.statuses.at(-1)).toMatchObject({
            retryAttemptCount: 2,
            retryDelayMs: 2_000,
            trigger: 'webgl-retry-scheduled',
        });
    });

    it('keeps jittered delays bounded and monotone in their base', () => {
        expect(terminalWebglRetryDelayMs(0, () => 0)).toBe(500);
        expect(terminalWebglRetryDelayMs(0, () => 1)).toBe(1_500);
        expect(terminalWebglRetryDelayMs(2, () => 0.5)).toBe(4_000);
        expect(terminalWebglRetryDelayMs(10, () => 1)).toBe(60_000);
        expect(terminalWebglRetryDelayMs(-1, () => 0.5)).toBe(1_000);
    });

    it('resolves a newly mounted pane to DOM once the session GPU incident budget is pinned', () => {
        const applyPreference = vi.fn();
        const harness = createHarness({
            policy: createPolicy({ applyPreference, isPinnedToDom: () => true }),
        });
        harness.controller.setPreference('on');

        expect(applyPreference).toHaveBeenCalledWith('on');
        expect(harness.host.loadAddon).not.toHaveBeenCalled();
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'context-loss-limit',
            trigger: 'preference-change',
        });
        // The pin suppresses the WebGL rebuild but still reports the restore so Main can count them after the pin.
        harness.redraw.mockClear();
        harness.controller.restoreVisible();
        expect(harness.redraw).toHaveBeenCalledWith('content-only');
        expect(harness.host.loadAddon).not.toHaveBeenCalled();
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'context-loss-limit',
            trigger: 'visibility-restore',
        });
    });

    it('re-probes WebGL2 for an unsupported pane when the window becomes visible again', () => {
        let isSupported = false;
        let isPinned = false;
        const harness = createHarness({
            policy: createPolicy({
                isPinnedToDom: () => isPinned,
                isWebgl2Available: () => isSupported,
            }),
        });
        harness.controller.setPreference('on');
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'dom', reason: 'unsupported' });

        // Still restarting: the restore is measured but nothing is created.
        harness.controller.restoreVisible();
        expect(harness.host.loadAddon).not.toHaveBeenCalled();
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'unsupported',
            trigger: 'visibility-restore',
        });

        // The GPU process is back: the same mount recovers WebGL without a remount or preference change.
        isSupported = true;
        harness.controller.restoreVisible();
        expect(harness.host.loadAddon).toHaveBeenCalledOnce();
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'webgl',
            reason: 'active',
            trigger: 'webgl-reprobe-succeeded',
        });

        // A session pinned meanwhile settles on the closed reason instead of probing.
        const pinnedHarness = createHarness({
            policy: createPolicy({
                isPinnedToDom: () => isPinned,
                isWebgl2Available: () => isSupported,
            }),
        });
        isSupported = false;
        pinnedHarness.controller.setPreference('on');
        isPinned = true;
        isSupported = true;
        pinnedHarness.controller.restoreVisible();
        expect(pinnedHarness.host.loadAddon).not.toHaveBeenCalled();
        expect(pinnedHarness.statuses.at(-1)).toMatchObject({
            reason: 'context-loss-limit',
            trigger: 'visibility-restore',
        });
    });

    it('converges an already-DOM pane with exhausted retries on the closed reason when the session pins', async () => {
        vi.useFakeTimers();
        let isPinned = false;
        const harness = createHarness({
            loadFailures: [2, 3, 4],
            policy: createPolicy({ isPinnedToDom: () => isPinned }),
        });
        harness.controller.setPreference('on');
        harness.controller.recoverFromGpuProcessLoss();
        await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
        expect(harness.statuses.at(-1)).toMatchObject({
            reason: 'load-failed',
            retryState: 'exhausted',
            trigger: 'webgl-retry-exhausted',
        });
        expect(harness.host.loadAddon).toHaveBeenCalledTimes(4);

        isPinned = true;
        const recovery = harness.controller.recoverFromGpuProcessLoss();

        expect(recovery).toBe('already-dom');
        expect(harness.statuses.at(-2)).toMatchObject({
            reason: 'context-loss-limit',
            trigger: 'gpu-incident-limit',
        });
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'context-loss-limit',
            retryState: 'idle',
            trigger: 'gpu-process-recovery',
        });
        expect(harness.statuses.at(-1)).not.toHaveProperty('retrySequenceId');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.host.loadAddon).toHaveBeenCalledTimes(4);
    });

    it('reports every lost WebGL context to the session policy exactly once', () => {
        const recordContextLoss = vi.fn();
        const harness = createHarness({ policy: createPolicy({ recordContextLoss }) });
        harness.controller.setPreference('on');

        harness.addon.loseContext();
        expect(recordContextLoss).toHaveBeenCalledOnce();
        // The Main-driven recovery of an already-DOM pane is not another lost context.
        harness.controller.recoverFromGpuProcessLoss();
        expect(recordContextLoss).toHaveBeenCalledOnce();

        harness.controller.setPreference('off');
        harness.controller.setPreference('on');
        harness.controller.recoverFromGpuProcessLoss();
        expect(recordContextLoss).toHaveBeenCalledTimes(2);
    });

    it('lets auto settle on DOM after repeated context-loss episodes while on keeps retrying', async () => {
        vi.useFakeTimers();
        for (const preference of ['auto', 'on'] as const) {
            const budget = createGpuIncidentBudget({ probeWebgl2: () => true });
            const harness = createHarness({ policy: budget });
            harness.controller.setPreference(preference);
            for (let episode = 0; episode < 3; episode += 1) {
                harness.addons.at(-1)?.loseContext();
                // The backoff retry (1 s, 2 s, 4 s) brings WebGL back before the next episode starts.
                // eslint-disable-next-line no-await-in-loop -- episodes are sequential by definition
                await vi.advanceTimersByTimeAsync(5_000);
            }
            expect(budget.contextLossEpisodeCount()).toBe(3);
            if (preference === 'auto') {
                expect(budget.isPinnedToDom()).toBe(true);
                expect(harness.statuses.at(-2)).toMatchObject({
                    reason: 'context-loss-limit',
                    trigger: 'gpu-incident-limit',
                });
                expect(harness.statuses.at(-1)).toMatchObject({
                    mode: 'dom',
                    reason: 'context-loss-limit',
                    retryState: 'idle',
                    trigger: 'webgl-context-loss',
                });
                expect(harness.host.loadAddon).toHaveBeenCalledTimes(3);
            } else {
                expect(budget.isPinnedToDom()).toBe(false);
                expect(harness.statuses.at(-1)).toMatchObject({ mode: 'webgl', reason: 'active' });
                expect(harness.host.loadAddon).toHaveBeenCalledTimes(4);
            }
        }
    });

    it('ends the retry sequence with a closed reason when the budget pins during recovery', async () => {
        vi.useFakeTimers();
        let isPinned = false;
        const harness = createHarness({ policy: createPolicy({ isPinnedToDom: () => isPinned }) });
        harness.controller.setPreference('on');

        harness.controller.recoverFromGpuProcessLoss();
        expect(harness.statuses.at(-1)).toMatchObject({ retryState: 'scheduled' });
        isPinned = true;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(harness.host.loadAddon).toHaveBeenCalledOnce();
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'context-loss-limit',
            retryDelayMs: null,
            retryState: 'exhausted',
            trigger: 'gpu-incident-limit',
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.host.loadAddon).toHaveBeenCalledOnce();

        // A pinned session never re-arms WebGL from a later GPU incident either.
        harness.controller.recoverFromGpuProcessLoss();
        expect(harness.statuses.at(-1)).toMatchObject({
            reason: 'context-loss-limit',
            trigger: 'gpu-process-recovery',
        });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(harness.host.loadAddon).toHaveBeenCalledOnce();
    });

    it('defers a retry until the Terminal is visible', async () => {
        vi.useFakeTimers();
        let isVisible = false;
        const harness = createHarness({ canRetry: () => isVisible });
        harness.controller.setPreference('on');

        harness.addon.loseContext();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(harness.host.loadAddon).toHaveBeenCalledOnce();
        expect(harness.statuses.at(-1)).toMatchObject({
            retryState: 'deferred',
            trigger: 'webgl-retry-deferred',
        });

        isVisible = true;
        harness.controller.restoreVisible();
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.host.loadAddon).toHaveBeenCalledTimes(2);
        expect(harness.statuses.at(-1)).toMatchObject({
            retryState: 'succeeded',
            trigger: 'webgl-retry-succeeded',
        });
    });

    it('cancels a scheduled retry when the user disables WebGL', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        harness.controller.setPreference('on');
        harness.addon.loseContext();

        harness.controller.setPreference('off');
        await vi.advanceTimersByTimeAsync(1_000);

        expect(harness.host.loadAddon).toHaveBeenCalledOnce();
        expect(harness.statuses).toContainEqual(
            expect.objectContaining({
                retryState: 'cancelled',
                trigger: 'webgl-retry-cancelled',
            }),
        );
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'disabled',
            retryState: 'idle',
        });
    });

    it('cancels a scheduled retry when the mounted Terminal is disposed', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        harness.controller.setPreference('on');
        harness.addon.loseContext();

        harness.controller.dispose();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(harness.host.loadAddon).toHaveBeenCalledOnce();
        expect(harness.statuses).toContainEqual(
            expect.objectContaining({
                retryState: 'cancelled',
                trigger: 'webgl-retry-cancelled',
            }),
        );
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'disposed',
            retryState: 'idle',
            trigger: 'dispose',
        });
    });

    it('rebuilds every enabled WebGL Terminal into DOM and schedules a retry after GPU process loss', () => {
        const harness = createHarness();
        harness.controller.setPreference('on');
        harness.redraw.mockClear();

        const recovery = harness.controller.recoverFromGpuProcessLoss();

        expect(recovery).toBe('dom-restored');
        expect(harness.addon.dispose).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledWith('grid-sync');
        expect(harness.statuses.at(-1)).toMatchObject({
            contextLossCount: 1,
            mode: 'dom',
            reason: 'context-loss',
            retryState: 'scheduled',
            trigger: 'gpu-process-recovery',
        });
    });

    it('redraws an already-DOM Terminal without loading WebGL during global recovery', () => {
        const harness = createHarness();
        harness.controller.setPreference('off');

        const recovery = harness.controller.recoverFromGpuProcessLoss();

        expect(recovery).toBe('already-dom');
        expect(harness.host.loadAddon).not.toHaveBeenCalled();
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledWith('content-only');
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'disabled',
            trigger: 'gpu-process-recovery',
        });
    });

    it('clears the texture atlas and redraws after the window becomes visible', () => {
        const harness = createHarness();
        harness.controller.setPreference('auto');
        harness.redraw.mockClear();
        harness.controller.restoreVisible();

        expect(harness.addon.clearTextureAtlas).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledWith('content-only');
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'webgl',
            reason: 'active',
            redrawCount: 2,
            trigger: 'visibility-restore',
        });
    });

    it('identifies an atlas-clear failure separately from an initial WebGL load failure', () => {
        const harness = createHarness();
        harness.controller.setPreference('auto');
        harness.redraw.mockClear();
        harness.addon.clearTextureAtlas.mockImplementationOnce(() => {
            throw new Error('GPU atlas unavailable');
        });

        harness.controller.restoreVisible();

        expect(harness.addon.dispose).toHaveBeenCalledTimes(1);
        expect(harness.redraw).toHaveBeenCalledWith('grid-sync');
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'load-failed',
            trigger: 'atlas-clear-failed',
        });
    });
});

describe('keep-alive suspend and resume', () => {
    it('releases the GPU context without repainting and reacquires a fresh one on the way back', () => {
        const harness = createHarness();
        harness.controller.setPreference('auto');
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'webgl', reason: 'active' });
        harness.redraw.mockClear();

        harness.controller.suspend();

        expect(harness.addons).toHaveLength(1);
        expect(harness.addons[0].dispose).toHaveBeenCalledTimes(1);
        // Repainting a pane nobody can see is exactly the work the keep-alive exists to avoid.
        expect(harness.redraw).not.toHaveBeenCalled();
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'suspended',
            trigger: 'keep-alive-suspend',
        });

        harness.controller.resume();

        expect(harness.addons).toHaveLength(2);
        expect(harness.statuses.at(-1)).toMatchObject({ mode: 'webgl', reason: 'active' });
        harness.controller.dispose();
    });

    it('never charges a suspended pane for a context it does not hold', () => {
        const recordContextLoss = vi.fn();
        const harness = createHarness({ policy: createPolicy({ recordContextLoss }) });
        harness.controller.setPreference('on');
        harness.controller.suspend();
        recordContextLoss.mockClear();

        expect(harness.controller.recoverFromGpuProcessLoss()).toBe('already-dom');
        expect(harness.controller.retryFromUser()).toBe(false);
        harness.controller.restoreVisible();

        expect(recordContextLoss).not.toHaveBeenCalled();
        // A window-restore or GPU-process event must not put a hidden pane back on the GPU behind the keep-alive's back.
        expect(harness.addons).toHaveLength(1);
        harness.controller.dispose();
    });

    it('records a preference changed while hidden and applies it only on resume', () => {
        const harness = createHarness();
        harness.controller.setPreference('auto');
        harness.controller.suspend();

        harness.controller.setPreference('off');

        expect(harness.statuses.at(-1)).toMatchObject({
            reason: 'suspended',
            trigger: 'keep-alive-suspend',
        });
        expect(harness.addons).toHaveLength(1);

        harness.controller.resume();

        expect(harness.addons).toHaveLength(1);
        expect(harness.redraw).toHaveBeenCalledWith('grid-sync');
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'disabled',
            trigger: 'keep-alive-resume',
        });
        harness.controller.dispose();
    });

    it('resumes a pane pinned by the session budget onto DOM instead of reacquiring a context', () => {
        const harness = createHarness({ policy: createPolicy({ isPinnedToDom: () => true }) });
        harness.controller.setPreference('on');
        harness.controller.suspend();
        harness.redraw.mockClear();

        harness.controller.resume();

        expect(harness.addons).toHaveLength(0);
        expect(harness.redraw).toHaveBeenCalledWith('grid-sync');
        expect(harness.statuses.at(-1)).toMatchObject({
            mode: 'dom',
            reason: 'context-loss-limit',
            trigger: 'keep-alive-resume',
        });
        harness.controller.dispose();
    });
});
