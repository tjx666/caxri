import type { LogEventName } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { WebContents } from 'electron';

import type { HangState } from './hang-policy';
import { beginHang, endHang, initialHangState } from './hang-policy';
import type {
    RendererStackCapture,
    RendererStackSampler,
} from './renderer-diagnostics/renderer-hang-stack';
import { createRendererStackSampler } from './renderer-diagnostics/renderer-hang-stack';

interface RendererHangEvents {
    responsive: LogEventName;
    unresponsive: LogEventName;
}

/**
 * How often Main asks the Renderer's main thread to run a trivial task.
 */
export const HANG_PROBE_INTERVAL_MS = 2_000;
/**
 * A probe left unanswered this long is a hang the user is already staring at.
 */
export const HANG_THRESHOLD_MS = 5_000;
/**
 * A Main tick this late means Main itself, or the whole machine (sleep), was suspended; the outstanding probe's age
 * then says nothing about the Renderer.
 */
const SUSPENDED_TICK_MS = HANG_PROBE_INTERVAL_MS * 3;

type HangEndCode = 'WINDOW_HANG_ABANDONED' | 'WINDOW_HANG_CLOSED' | 'WINDOW_RESPONSIVE';

export interface RendererHangObserverDependencies {
    /**
     * Resolves once the Renderer's main thread has run a trivial task.
     */
    probe?: (webContents: WebContents) => Promise<unknown>;
    createStackSampler?: (webContents: WebContents) => RendererStackSampler;
    now?: () => number;
}

/**
 * Records Renderer main-thread hangs for one window and where they were stuck.
 *
 * Chromium's own `unresponsive` event is not used: it only fires once an input event has waited ~30s for an ack, and a
 * 96s freeze during a Session switch never fired it at all. Main instead probes the main thread every
 * {@link HANG_PROBE_INTERVAL_MS}; a probe unanswered for {@link HANG_THRESHOLD_MS} opens a hang, briefly pauses the
 * Renderer through `webContents.debugger` (see `createRendererStackSampler`) to name the stuck call stack, and the next
 * answered probe closes it with its duration. A hang still open when the Renderer dies or the window closes (the user
 * quitting a frozen app) is closed with that outcome, so the log never holds a hang without its end.
 *
 * This is observation only. A hang never reloads the window and never consumes the crash-recovery budget in
 * `crash-policy.ts`: long synchronous work is not by itself a fault. The entry is `warn` and the end is `info` so
 * neither trips the E2E error gate, which treats any `error` desktop record as fatal.
 */
export function observeRendererHangs(
    webContents: WebContents,
    events: RendererHangEvents,
    /**
     * Resolved per event so a window whose logger is created lazily still records its hangs.
     */
    logger: () => Pick<StructuredLogger, 'write'> | undefined,
    /**
     * Guards a reused observer against a superseded window, mirroring the `render-process-gone` handlers.
     */
    isCurrent: () => boolean = () => true,
    dependencies: RendererHangObserverDependencies = {},
): void {
    const probe = dependencies.probe ?? ((contents) => contents.executeJavaScript('0'));
    const sampler = (dependencies.createStackSampler ?? createRendererStackSampler)(webContents);
    const now = dependencies.now ?? Date.now;

    let state: HangState = initialHangState;
    /**
     * The probe in flight. `generation` lets a superseded probe (sent before a reload or a suspension) settle without
     * closing a hang it never measured.
     */
    let pending: { generation: number; sentAtMs: number } | undefined;
    let generation = 0;
    let lastTickAtMs = now();
    /**
     * Settles once the open hang's entry record is written, so its end can never be logged before it.
     */
    let entryWritten: Promise<void> = Promise.resolve();

    const timer = setInterval(tick, HANG_PROBE_INTERVAL_MS);
    timer.unref();

    webContents.on('render-process-gone', () => {
        pending = undefined;
        generation += 1;
        if (!isCurrent()) return;
        closeHang('WINDOW_HANG_ABANDONED');
    });
    webContents.on('destroyed', () => {
        clearInterval(timer);
        pending = undefined;
        closeHang('WINDOW_HANG_CLOSED');
    });

    function tick(): void {
        const tickAtMs = now();
        const isSuspended = tickAtMs - lastTickAtMs >= SUSPENDED_TICK_MS;
        lastTickAtMs = tickAtMs;
        if (webContents.isDestroyed() || !isCurrent()) return;
        /**
         * A loading page answers only after it loads, and a DevTools breakpoint is a pause the developer chose.
         */
        if (isSuspended || webContents.isLoading() || webContents.isDevToolsOpened()) {
            pending = undefined;
            generation += 1;
            return;
        }
        if (pending) {
            if (
                state.startedAtMs === undefined &&
                tickAtMs - pending.sentAtMs >= HANG_THRESHOLD_MS
            ) {
                openHang(pending.sentAtMs, tickAtMs);
            }
            return;
        }
        sendProbe(tickAtMs);
    }

    function sendProbe(sentAtMs: number): void {
        const sent = { generation, sentAtMs };
        pending = sent;
        void awaitProbe(sent);
    }

    async function awaitProbe(sent: { generation: number; sentAtMs: number }): Promise<void> {
        try {
            await probe(webContents);
        } catch {
            if (pending === sent) pending = undefined;
            return;
        }
        if (pending !== sent || sent.generation !== generation) return;
        pending = undefined;
        if (isCurrent()) closeHang('WINDOW_RESPONSIVE');
    }

    function openHang(startedAtMs: number, detectedAtMs: number): void {
        const started = beginHang(state, startedAtMs);
        state = started.state;
        const { record } = started;
        if (!record) return;
        entryWritten = writeEntry(record.hangCount, startedAtMs, detectedAtMs);
    }

    async function writeEntry(
        hangCount: number,
        startedAtMs: number,
        detectedAtMs: number,
    ): Promise<void> {
        let capture: RendererStackCapture;
        try {
            capture = await sampler.capture();
        } catch {
            capture = { outcome: 'failed' };
        }
        if (state.startedAtMs !== startedAtMs && capture.outcome === 'captured')
            capture = { outcome: 'ended' };
        logger()?.write('warn', events.unresponsive, {
            fields: {
                code: 'WINDOW_UNRESPONSIVE',
                hangCount,
                blockedMs: detectedAtMs - startedAtMs,
                stackOutcome: capture.outcome,
                ...(capture.stack !== undefined && { stack: capture.stack }),
            },
        });
    }

    function closeHang(code: HangEndCode): void {
        const ended = endHang(state, now());
        state = ended.state;
        const { record } = ended;
        if (!record) return;
        void writeEnd(code, record);
    }

    async function writeEnd(
        code: HangEndCode,
        record: { hangCount: number; durationMs: number },
    ): Promise<void> {
        await entryWritten;
        logger()?.write('info', events.responsive, {
            fields: { code, hangCount: record.hangCount, durationMs: record.durationMs },
        });
    }
}
