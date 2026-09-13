import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { observeRendererHangs } from '../renderer-hang-observer';

const EVENTS = { responsive: 'window.responsive', unresponsive: 'window.unresponsive' } as const;

/**
 * The observer only ever calls `on`, so a listener registry is enough to drive the three transitions under test without
 * a real Chromium `WebContents`.
 */
function observe(isCurrent?: () => boolean) {
    const listeners = new Map<string, Array<() => void>>();
    const webContents = {
        on: (event: string, listener: () => void) => {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
            return webContents;
        },
    } as unknown as WebContents;
    const write = vi.fn();
    observeRendererHangs(webContents, EVENTS, () => ({ write }), isCurrent);
    return {
        emit: (event: string) => {
            const registered = listeners.get(event) ?? [];
            for (const listener of registered) listener();
        },
        write,
    };
}

describe('renderer hang observer', () => {
    it('records a hang and the recovery that ended it', () => {
        const { emit, write } = observe();

        emit('unresponsive');
        emit('responsive');

        expect(write).toHaveBeenNthCalledWith(1, 'warn', 'window.unresponsive', {
            fields: { code: 'WINDOW_UNRESPONSIVE', hangCount: 1 },
        });
        expect(write).toHaveBeenNthCalledWith(2, 'info', 'window.responsive', {
            fields: {
                code: 'WINDOW_RESPONSIVE',
                durationMs: expect.any(Number) as number,
                hangCount: 1,
            },
        });
    });

    /**
     * A Renderer that dies while hung never fires `responsive`. The regression this guards is the silent one: with the
     * hang left open, the reloaded window's next `unresponsive` is deduplicated away as a repeat of the dead one and
     * the window stops reporting hangs entirely.
     */
    it('closes a hang whose Renderer process died, and keeps counting afterwards', () => {
        const { emit, write } = observe();

        emit('unresponsive');
        emit('render-process-gone');

        expect(write).toHaveBeenNthCalledWith(2, 'info', 'window.responsive', {
            fields: {
                code: 'WINDOW_HANG_ABANDONED',
                durationMs: expect.any(Number) as number,
                hangCount: 1,
            },
        });

        emit('unresponsive');

        expect(write).toHaveBeenNthCalledWith(3, 'warn', 'window.unresponsive', {
            fields: { code: 'WINDOW_UNRESPONSIVE', hangCount: 2 },
        });
    });

    it('records nothing for a crash with no hang in progress', () => {
        const { emit, write } = observe();

        emit('render-process-gone');

        expect(write).not.toHaveBeenCalled();
    });

    it('ignores every transition once the window is superseded', () => {
        const { emit, write } = observe(() => false);

        emit('unresponsive');
        emit('render-process-gone');
        emit('responsive');

        expect(write).not.toHaveBeenCalled();
    });
});
