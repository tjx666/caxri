import { describe, expect, it } from 'vitest';

import { bringWindowForward, resolveE2EWindowMode } from '../window-mode';

describe('resolveE2EWindowMode', () => {
    it('keeps focused E2E hidden unless the launch explicitly requests a visible desktop', () => {
        expect(resolveE2EWindowMode({ isE2E: true })).toBe('hidden');
        expect(resolveE2EWindowMode({ isE2E: true, requestedMode: 'hidden' })).toBe('hidden');
        expect(resolveE2EWindowMode({ isE2E: true, requestedMode: 'visible' })).toBe('visible');
        expect(resolveE2EWindowMode({ isE2E: true, requestedMode: 'invalid' })).toBe('hidden');
    });

    it('never lets the E2E-only environment hide a production window', () => {
        expect(resolveE2EWindowMode({ isE2E: false, requestedMode: 'hidden' })).toBe('visible');
    });
});

describe('bringWindowForward', () => {
    function fakeTarget(isMinimized = false) {
        const calls: string[] = [];
        const window = {
            isMinimized: () => isMinimized,
            restore: () => calls.push('restore'),
            show: () => calls.push('show'),
            focus: () => calls.push('window.focus'),
            webContents: { focus: () => calls.push('webContents.focus') },
        };
        const app = {
            focus: (options: { steal: boolean }) => calls.push(`app.focus:${options.steal}`),
        };
        return { app, calls, window };
    }

    it('shows the window and steals OS focus in production and visible E2E launches', () => {
        const { app, calls, window } = fakeTarget(true);
        bringWindowForward({ app, window, windowMode: 'visible' });
        expect(calls).toEqual(['restore', 'show', 'app.focus:true', 'window.focus']);
    });

    it('keeps a hidden E2E window hidden and leaves OS focus with the foreground app', () => {
        const { app, calls, window } = fakeTarget(true);
        bringWindowForward({ app, window, windowMode: 'hidden' });
        expect(calls).toEqual(['webContents.focus']);
    });
});
