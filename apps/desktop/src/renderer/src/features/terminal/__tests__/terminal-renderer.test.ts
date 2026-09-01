import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalRendererStatus } from '../terminal-renderer';
import {
    isWebgl2Available,
    resolveTerminalRendererTarget,
    TerminalRendererController,
} from '../terminal-renderer';

class FakeWebglAddon implements ITerminalAddon {
    private listener: (() => void) | undefined;
    readonly clearTextureAtlas = vi.fn();
    readonly dispose = vi.fn();

    activate(): void {}

    onContextLoss(listener: () => void) {
        this.listener = listener;
        return {
            dispose: () => {
                if (this.listener === listener) this.listener = undefined;
            },
        };
    }

    loseContext(): void {
        this.listener?.();
    }
}

function createHarness(
    options: {
        canRetry?: () => boolean;
        loadError?: Error;
        loadFailures?: number[];
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
        () => options.supported ?? true,
        () => {
            const addon = new FakeWebglAddon();
            addons.push(addon);
            return addon;
        },
        options.canRetry ?? (() => true),
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

    it('stops after three failed retry attempts in one rolling window', async () => {
        vi.useFakeTimers();
        const harness = createHarness({ loadFailures: [2, 3, 4] });
        harness.controller.setPreference('on');

        harness.addon.loseContext();
        await vi.advanceTimersByTimeAsync(3_000);

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
