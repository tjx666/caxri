import type { ServerEvent } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
    createWindowZoomController,
    mainWindowChromeOptions,
    publishFullScreenState,
    trafficLightPositionForZoom,
    zoomFactorForLevel,
} from '../window-chrome';

describe('window zoom', () => {
    it('scales by 20% per level, matching Chromium and VS Code', () => {
        expect(zoomFactorForLevel(0)).toBe(1);
        expect(zoomFactorForLevel(1)).toBeCloseTo(1.2);
        expect(zoomFactorForLevel(-1)).toBeCloseTo(1 / 1.2);
    });

    it('keeps the traffic lights centered in the zoomed 44px header', () => {
        expect(trafficLightPositionForZoom(1)).toEqual({ x: 15, y: 15 });
        expect(trafficLightPositionForZoom(1.44)).toEqual({ x: 15, y: 25 });
        expect(trafficLightPositionForZoom(1 / 1.2)).toEqual({ x: 15, y: 11 });
    });
});

describe('mainWindowChromeOptions', () => {
    it('uses a translucent vibrancy backdrop only on macOS', () => {
        expect(mainWindowChromeOptions(1, 'darwin')).toMatchObject({
            backgroundColor: '#00000000',
            vibrancy: 'under-window',
        });
        expect(mainWindowChromeOptions(1, 'linux')).toMatchObject({ backgroundColor: '#282a36' });
        expect(mainWindowChromeOptions(1, 'linux')).not.toHaveProperty('vibrancy');
    });
});

describe('createWindowZoomController', () => {
    function fakeWindow() {
        const setZoomLevel = vi.fn();
        const setWindowButtonPosition = vi.fn();
        const window = {
            isDestroyed: () => false,
            webContents: { setZoomLevel },
            setWindowButtonPosition,
        } as unknown as BrowserWindow;
        return { window, setZoomLevel, setWindowButtonPosition };
    }

    it('applies a settings write only when the zoom level changed', async () => {
        const { window, setZoomLevel } = fakeWindow();
        let level = 2;
        const controller = createWindowZoomController({
            loadLevel: () => Promise.resolve(level),
            windows: () => [window],
        });

        await expect(controller.load()).resolves.toBe(2);
        controller.refresh();
        await vi.waitFor(() => expect(setZoomLevel).not.toHaveBeenCalled());

        level = 3;
        controller.refresh();
        await vi.waitFor(() => expect(setZoomLevel).toHaveBeenCalledWith(3));
    });

    it('zooms every window that follows the app zoom, and remembers the level for the next one', async () => {
        const workbench = fakeWindow();
        const commander = fakeWindow();
        let level = 0;
        const controller = createWindowZoomController({
            loadLevel: () => Promise.resolve(level),
            windows: () => [workbench.window, undefined, commander.window],
        });
        await controller.load();

        level = -1;
        controller.refresh();

        await vi.waitFor(() => expect(commander.setZoomLevel).toHaveBeenCalledWith(-1));
        expect(workbench.setZoomLevel).toHaveBeenCalledWith(-1);
        expect(commander.setWindowButtonPosition).toHaveBeenCalledWith(
            trafficLightPositionForZoom(zoomFactorForLevel(-1)),
        );
        expect(controller.level()).toBe(-1);
    });

    it('keeps the current level when the settings read fails', async () => {
        const controller = createWindowZoomController({
            loadLevel: () => Promise.reject(new Error('offline')),
            windows: () => [],
        });

        await expect(controller.load()).resolves.toBe(0);
    });
});

describe('publishFullScreenState', () => {
    it('names the window whose fullscreen state changed, on every transition', () => {
        let isFullScreen = false;
        const listeners = new Map<string, () => void>();
        const on = (name: string, listener: () => void) => listeners.set(name, listener);
        const window = { isFullScreen: () => isFullScreen, on };
        const emit = (name: string) => listeners.get(name)?.();
        const sendEvent = vi.fn<(event: ServerEvent) => void>();
        publishFullScreenState(window as unknown as BrowserWindow, 'agentCommander', sendEvent);

        isFullScreen = true;
        emit('enter-full-screen');
        isFullScreen = false;
        emit('leave-full-screen');

        expect(sendEvent.mock.calls.map(([event]) => event)).toEqual(
            [true, false].map((value) => ({
                event: 'window.fullScreen',
                payload: { window: 'agentCommander', isFullScreen: value },
            })),
        );
    });
});
