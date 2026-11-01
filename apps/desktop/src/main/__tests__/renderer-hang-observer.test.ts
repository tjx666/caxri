import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RendererStackCapture } from '../renderer-diagnostics/renderer-hang-stack';
import {
    HANG_PROBE_INTERVAL_MS,
    HANG_THRESHOLD_MS,
    observeRendererHangs,
} from '../renderer-hang-observer';

const EVENTS = { responsive: 'window.responsive', unresponsive: 'window.unresponsive' } as const;
const STACK = 'loop@index-abc.js:1:42;render@index-abc.js:1:7';

/**
 * Drives the observer with a fake `WebContents` whose main thread answers probes only while `blocked` is false, so a
 * test can freeze and thaw it between fake-timer steps.
 */
function observe(
    options: { isCurrent?: () => boolean; capture?: () => Promise<RendererStackCapture> } = {},
) {
    const listeners = new Map<string, Array<() => void>>();
    let isBlocked = false;
    let waiting: Array<() => void> = [];
    const flags = { devTools: false, loading: false };
    const webContents = {
        on: (event: string, listener: () => void) => {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
            return webContents;
        },
        isDestroyed: () => false,
        isLoading: () => flags.loading,
        isDevToolsOpened: () => flags.devTools,
    } as unknown as WebContents;
    const probe = vi.fn(
        () =>
            new Promise<void>((resolve) => {
                if (isBlocked) waiting.push(resolve);
                else resolve();
            }),
    );
    const captureStack = vi.fn(
        options.capture ??
            ((): Promise<RendererStackCapture> =>
                Promise.resolve({ outcome: 'captured', stack: STACK })),
    );
    const write = vi.fn();
    observeRendererHangs(webContents, EVENTS, () => ({ write }), options.isCurrent, {
        probe,
        createStackSampler: () => ({ capture: captureStack }),
        now: Date.now,
    });
    return {
        captureStack,
        flags,
        freeze: () => {
            isBlocked = true;
        },
        thaw: () => {
            isBlocked = false;
            for (const resolve of waiting) resolve();
            waiting = [];
        },
        emit: (event: string) => {
            const registered = listeners.get(event) ?? [];
            for (const listener of registered) listener();
        },
        probe,
        write,
    };
}

/**
 * One probe interval to send the probe that will hang, the threshold, then the tick that notices it.
 */
async function hangPastThreshold(): Promise<void> {
    await vi.advanceTimersByTimeAsync(HANG_PROBE_INTERVAL_MS * 2 + HANG_THRESHOLD_MS);
}

describe('renderer hang observer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('records nothing while every probe is answered', async () => {
        const { probe, write } = observe();

        await vi.advanceTimersByTimeAsync(HANG_PROBE_INTERVAL_MS * 10);

        expect(probe).toHaveBeenCalledTimes(10);
        expect(write).not.toHaveBeenCalled();
    });

    it('records a hang with its stack and the recovery that ended it', async () => {
        const { freeze, thaw, write } = observe();

        freeze();
        await hangPastThreshold();

        expect(write).toHaveBeenCalledWith('warn', 'window.unresponsive', {
            fields: {
                code: 'WINDOW_UNRESPONSIVE',
                hangCount: 1,
                blockedMs: expect.any(Number) as number,
                stackOutcome: 'captured',
                stack: STACK,
            },
        });
        const entry = (
            write.mock.calls[0] as [string, string, { fields: { blockedMs: number } }]
        )[2];
        expect(entry.fields.blockedMs).toBeGreaterThanOrEqual(HANG_THRESHOLD_MS);

        await vi.advanceTimersByTimeAsync(3_000);
        thaw();
        await vi.advanceTimersByTimeAsync(0);

        expect(write).toHaveBeenNthCalledWith(2, 'info', 'window.responsive', {
            fields: {
                code: 'WINDOW_RESPONSIVE',
                hangCount: 1,
                durationMs: expect.any(Number) as number,
            },
        });
        const end = (
            write.mock.calls[1] as [string, string, { fields: { durationMs: number } }]
        )[2];
        expect(end.fields.durationMs).toBeGreaterThanOrEqual(HANG_THRESHOLD_MS + 3_000);
    });

    it('captures the stack once per continuous hang', async () => {
        const { captureStack, freeze, write } = observe();

        freeze();
        await hangPastThreshold();
        await vi.advanceTimersByTimeAsync(HANG_PROBE_INTERVAL_MS * 20);

        expect(captureStack).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledTimes(1);
    });

    it('records a stack capture that could not attach, without a stack', async () => {
        const { freeze, write } = observe({
            capture: () => Promise.resolve({ outcome: 'debugger-busy' }),
        });

        freeze();
        await hangPastThreshold();

        expect(write).toHaveBeenCalledWith('warn', 'window.unresponsive', {
            fields: {
                code: 'WINDOW_UNRESPONSIVE',
                hangCount: 1,
                blockedMs: expect.any(Number) as number,
                stackOutcome: 'debugger-busy',
            },
        });
    });

    /**
     * A pause that lands after the hang ended stops on whatever runs next, which would blame unrelated code.
     */
    it('drops a stack captured after the hang already ended', async () => {
        const landing = Promise.withResolvers<RendererStackCapture>();
        const { freeze, thaw, write } = observe({ capture: () => landing.promise });

        freeze();
        await hangPastThreshold();
        thaw();
        await vi.advanceTimersByTimeAsync(0);
        landing.resolve({ outcome: 'captured', stack: STACK });
        await vi.advanceTimersByTimeAsync(0);

        expect(write).toHaveBeenNthCalledWith(1, 'warn', 'window.unresponsive', {
            fields: {
                code: 'WINDOW_UNRESPONSIVE',
                hangCount: 1,
                blockedMs: expect.any(Number) as number,
                stackOutcome: 'ended',
            },
        });
        expect(write).toHaveBeenNthCalledWith(2, 'info', 'window.responsive', expect.anything());
    });

    /**
     * The reported freeze ended with the user quitting the app. Before, that left a hang with no end in the log.
     */
    it('closes a hang still open when the window is destroyed', async () => {
        const { emit, freeze, write } = observe();

        freeze();
        await hangPastThreshold();
        emit('destroyed');
        await vi.advanceTimersByTimeAsync(0);

        expect(write).toHaveBeenNthCalledWith(2, 'info', 'window.responsive', {
            fields: {
                code: 'WINDOW_HANG_CLOSED',
                hangCount: 1,
                durationMs: expect.any(Number) as number,
            },
        });
    });

    /**
     * A Renderer that dies while hung never answers its probe. Left open, the reloaded window's next hang would be
     * deduplicated away as a repeat of the dead one and the window would stop reporting hangs entirely.
     */
    it('closes a hang whose Renderer process died, and keeps counting afterwards', async () => {
        const { emit, freeze, write } = observe();

        freeze();
        await hangPastThreshold();
        emit('render-process-gone');
        await vi.advanceTimersByTimeAsync(0);

        expect(write).toHaveBeenNthCalledWith(2, 'info', 'window.responsive', {
            fields: {
                code: 'WINDOW_HANG_ABANDONED',
                hangCount: 1,
                durationMs: expect.any(Number) as number,
            },
        });

        await hangPastThreshold();

        expect(write).toHaveBeenNthCalledWith(
            3,
            'warn',
            'window.unresponsive',
            expect.objectContaining({
                fields: expect.objectContaining({ hangCount: 2 }) as unknown,
            }),
        );
    });

    it('does not count a page load or an open DevTools as a hang', async () => {
        const { flags, freeze, write } = observe();

        freeze();
        flags.loading = true;
        await hangPastThreshold();
        flags.loading = false;
        flags.devTools = true;
        await hangPastThreshold();

        expect(write).not.toHaveBeenCalled();
    });

    it('does not count a suspended Main or machine as a hang', async () => {
        const { freeze, probe, write } = observe();
        await vi.advanceTimersByTimeAsync(HANG_PROBE_INTERVAL_MS);
        freeze();
        await vi.advanceTimersByTimeAsync(HANG_PROBE_INTERVAL_MS);
        expect(probe).toHaveBeenCalledTimes(2);

        // The system clock jumps past the threshold without any tick in between, as after sleep.
        vi.setSystemTime(Date.now() + 60_000);
        await vi.advanceTimersByTimeAsync(HANG_PROBE_INTERVAL_MS);

        expect(write).not.toHaveBeenCalled();
    });

    it('ignores every transition once the window is superseded', async () => {
        const { emit, freeze, write } = observe({ isCurrent: () => false });

        freeze();
        await hangPastThreshold();
        emit('render-process-gone');

        expect(write).not.toHaveBeenCalled();
    });
});
