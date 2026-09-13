import type { LogEventName } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { WebContents } from 'electron';

import type { HangState } from './hang-policy';
import { beginHang, endHang, initialHangState } from './hang-policy';

interface RendererHangEvents {
    responsive: LogEventName;
    unresponsive: LogEventName;
}

/**
 * Records Renderer hangs for one window. Chromium fires `unresponsive` when the main thread has been blocked past its
 * own ~30s threshold and `responsive` when it recovers.
 *
 * This is observation only. A hang never reloads the window, never consumes the crash-recovery budget in
 * `crash-policy.ts`, and never reaches a terminal state: the threshold is not tunable, and long synchronous work is not
 * by itself a fault. The entry is `warn` and the recovery is `info` so neither trips the E2E error gate, which treats
 * any `error` desktop record as fatal.
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
): void {
    let state: HangState = initialHangState;
    webContents.on('unresponsive', () => {
        if (!isCurrent()) return;
        const started = beginHang(state, Date.now());
        state = started.state;
        if (!started.record) return;
        logger()?.write('warn', events.unresponsive, {
            fields: { code: 'WINDOW_UNRESPONSIVE', hangCount: started.record.hangCount },
        });
    });
    webContents.on('responsive', () => {
        if (!isCurrent()) return;
        const ended = endHang(state, Date.now());
        state = ended.state;
        if (!ended.record) return;
        logger()?.write('info', events.responsive, {
            fields: {
                code: 'WINDOW_RESPONSIVE',
                hangCount: ended.record.hangCount,
                durationMs: ended.record.durationMs,
            },
        });
    });
}
