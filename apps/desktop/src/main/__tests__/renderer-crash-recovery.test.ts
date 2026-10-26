import type { BrowserWindow, RenderProcessGoneDetails } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { observeRendererCrashes } from '../renderer-crash-recovery';

vi.mock('electron', () => ({ app: {}, dialog: { showMessageBox: vi.fn() }, shell: {} }));

/**
 * The observer only registers `render-process-gone` and calls `reload`, so a listener registry is enough to drive it
 * without a real Chromium `WebContents`.
 */
function observe(isQuitting: () => boolean) {
    let listener: ((event: unknown, details: RenderProcessGoneDetails) => void) | undefined;
    const reload = vi.fn();
    const window = {
        isDestroyed: () => false,
        reload,
        webContents: {
            on: (_event: string, registered: typeof listener) => {
                listener = registered;
            },
        },
    } as unknown as BrowserWindow;
    const write = vi.fn();
    observeRendererCrashes(window, {
        isQuitting,
        logDirectory: '/profile/logs',
        logger: () => ({ write }) as never,
        shutdown: vi.fn(),
    });
    return {
        kill: () => listener?.({}, { reason: 'killed', exitCode: 15 }),
        reload,
        write,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('observeRendererCrashes', () => {
    it('reloads a Renderer killed while the app is running', async () => {
        vi.useFakeTimers();
        const { kill, reload } = observe(() => false);

        kill();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(reload).toHaveBeenCalledOnce();
    });

    it('does not reload a Renderer killed by the teardown of an accepted quit', async () => {
        vi.useFakeTimers();
        const { kill, reload, write } = observe(() => true);

        kill();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(reload).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledWith('info', 'window.render_process_gone', {
            fields: {
                code: 'RENDER_PROCESS_GONE',
                reason: 'killed',
                exitCode: 15,
                source: 'app-quitting',
            },
        });
    });
});
