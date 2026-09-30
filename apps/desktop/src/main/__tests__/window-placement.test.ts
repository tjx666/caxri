import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { WindowPlacement } from '../window-placement';
import { defaultWindowState, showWhenPlaced } from '../window-placement';

function createFakeWindow() {
    const calls: string[] = [];
    const listeners = new Map<string, () => void>();
    const window = {
        calls,
        emit: (event: string) => listeners.get(event)?.(),
        once: (event: string, listener: () => void) => listeners.set(event, listener),
        center: () => calls.push('center'),
        isDestroyed: () => false,
        maximize: () => calls.push('maximize'),
        setBounds: (bounds: Electron.Rectangle) =>
            calls.push(`setBounds ${JSON.stringify(bounds)}`),
        setFullScreen: () => calls.push('setFullScreen'),
        setSize: (width: number, height: number) => calls.push(`setSize ${width}x${height}`),
        setWindowButtonPosition: () => {},
        webContents: {
            executeJavaScript: vi.fn(() => Promise.resolve(calls.push('frame'))),
            setZoomLevel: (level: number) => calls.push(`zoom ${level}`),
        },
    };
    return window;
}

const flush = async (): Promise<void> => {
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
};

describe('showWhenPlaced', () => {
    it('waits for both the first paint and the placement before showing', async () => {
        const window = createFakeWindow();
        const placement = Promise.withResolvers<WindowPlacement>();
        const show = vi.fn();

        showWhenPlaced(window as unknown as BrowserWindow, placement.promise, show);
        window.emit('ready-to-show');
        await flush();
        expect(show).not.toHaveBeenCalled();

        placement.resolve({
            state: {
                bounds: { x: 10, y: 20, width: 1200, height: 800 },
                isMaximized: true,
                isFullScreen: false,
            },
            zoomLevel: 0,
        });
        await flush();

        expect(window.calls).toEqual([
            'setBounds {"x":10,"y":20,"width":1200,"height":800}',
            'maximize',
        ]);
        expect(show).toHaveBeenCalledOnce();
    });

    it('centers a window without a saved position and presents a re-zoomed frame before showing', async () => {
        const window = createFakeWindow();
        const show = vi.fn(() => window.calls.push('show'));

        showWhenPlaced(
            window as unknown as BrowserWindow,
            Promise.resolve({ state: defaultWindowState, zoomLevel: 1 }),
            show,
        );
        window.emit('ready-to-show');
        await flush();

        expect(window.calls).toEqual(['setSize 1440x900', 'center', 'zoom 1', 'frame', 'show']);
    });

    it('stays hidden while the placement never arrives', async () => {
        const window = createFakeWindow();
        const show = vi.fn();

        showWhenPlaced(window as unknown as BrowserWindow, new Promise(() => {}), show);
        window.emit('ready-to-show');
        await flush();

        expect(show).not.toHaveBeenCalled();
    });
});
