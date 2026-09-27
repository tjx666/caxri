import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import {
    createWindowZoomController,
    mainWindowChromeOptions,
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
        const window = {
            isDestroyed: () => false,
            webContents: { setZoomLevel },
            setWindowButtonPosition: vi.fn(),
        } as unknown as BrowserWindow;
        return { window, setZoomLevel };
    }

    it('applies a settings write only when the zoom level changed', async () => {
        const { window, setZoomLevel } = fakeWindow();
        let level = 2;
        const controller = createWindowZoomController({
            loadLevel: () => Promise.resolve(level),
            window: () => window,
        });

        await expect(controller.load()).resolves.toBe(2);
        controller.refresh();
        await vi.waitFor(() => expect(setZoomLevel).not.toHaveBeenCalled());

        level = 3;
        controller.refresh();
        await vi.waitFor(() => expect(setZoomLevel).toHaveBeenCalledWith(3));
    });

    it('keeps the current level when the settings read fails', async () => {
        const controller = createWindowZoomController({
            loadLevel: () => Promise.reject(new Error('offline')),
            window: () => {},
        });

        await expect(controller.load()).resolves.toBe(0);
    });
});
