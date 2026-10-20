import { describe, expect, it, vi } from 'vitest';

import type { TearOffBrowserWindow } from '../tear-off-windows';
import { createTearOffWindows } from '../tear-off-windows';
import { WorkbenchWindows } from '../workbench-windows';

const DISPLAY = { x: 0, y: 0, width: 2560, height: 1440 };
const BOUNDS = { x: 100, y: 100, width: 1200, height: 800 };

function fakeWindow(): TearOffBrowserWindow {
    return {
        destroy: vi.fn(),
        getBounds: () => BOUNDS,
        getNormalBounds: () => BOUNDS,
        isDestroyed: () => false,
        isFocused: () => false,
        webContents: { send: vi.fn() },
    };
}

function setup(records: Array<{ windowKey: string; activeSessionId: string | null }> = []) {
    const windows = new WorkbenchWindows<TearOffBrowserWindow>();
    const primary = fakeWindow();
    windows.add('main', primary);
    const request = vi.fn((method: string) =>
        Promise.resolve(method === 'window.openSessions.listTearOffs' ? records : null),
    );
    const created: string[] = [];
    const tearOffs = createTearOffWindows({
        createWindow: ({ windowKey }) => {
            created.push(windowKey);
            const window = fakeWindow();
            windows.add(windowKey, window);
            return window;
        },
        cursorPoint: () => ({ x: 1800, y: 1000 }),
        logger: () => {},
        primaryReady: () => Promise.resolve(),
        register: vi.fn(),
        serverReady: Promise.resolve(),
        supervisor: () => ({ request }) as never,
        windows,
        workAreas: () => [DISPLAY],
        zoomLevel: () => 0,
    });
    return { created, primary, request, tearOffs, windows };
}

describe('tear-off window lifecycle', () => {
    it('releases the strip when the user closes a tear-off window', () => {
        const { request, tearOffs } = setup();

        tearOffs.onClosed('win-1', false);

        expect(request).toHaveBeenCalledWith('window.openSessions.release', { windowKey: 'win-1' });
    });

    it('keeps the strip when the app is quitting', () => {
        const { request, tearOffs } = setup();

        tearOffs.onClosed('win-1', true);

        expect(request).not.toHaveBeenCalled();
    });

    it('keeps the strips of tear-offs destroyed by closing the primary window', () => {
        const { request, tearOffs, windows } = setup();
        const tearOff = fakeWindow();
        const destroy = vi.fn();
        tearOff.destroy = destroy;
        windows.add('win-1', tearOff);

        tearOffs.closeKeepingStrips();
        tearOffs.onClosed('win-1', false);

        expect(destroy).toHaveBeenCalledOnce();
        expect(request).not.toHaveBeenCalled();
    });

    it('reopens the stored tear-off windows at launch', async () => {
        const { created, primary, tearOffs } = setup([
            { windowKey: 'win-1', activeSessionId: 'session-1' },
            { windowKey: 'win-2', activeSessionId: null },
        ]);

        await tearOffs.restore(primary);

        expect(created).toEqual(['win-1', 'win-2']);
    });

    it('does not reopen a window that is already live', async () => {
        const { created, primary, tearOffs, windows } = setup([
            { windowKey: 'win-1', activeSessionId: 'session-1' },
        ]);
        windows.add('win-1', fakeWindow());

        await tearOffs.restore(primary);

        expect(created).toEqual([]);
    });
});
