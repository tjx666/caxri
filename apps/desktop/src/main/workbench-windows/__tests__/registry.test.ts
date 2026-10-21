import { describe, expect, it, vi } from 'vitest';

import { EVENT_AUDIENCE, eventAudience } from '../event-audience';
import { createWorkbenchEventDelivery, WorkbenchWindows } from '../registry';

function fakeWindow(options: { focused?: boolean; destroyed?: boolean } = {}) {
    const send = vi.fn();
    return {
        isDestroyed: () => options.destroyed ?? false,
        isFocused: () => options.focused ?? false,
        webContents: { send },
        send,
    };
}

describe('WorkbenchWindows', () => {
    it('removes a window whose BrowserWindow already throws on webContents (a closed window)', () => {
        const windows = new WorkbenchWindows();
        const webContents = { send: vi.fn() };
        let isDestroyed = false;
        windows.add('win-1', {
            isDestroyed: () => isDestroyed,
            isFocused: () => false,
            get webContents() {
                if (isDestroyed) throw new TypeError('Object has been destroyed');
                return webContents;
            },
        });
        isDestroyed = true;
        expect(() => windows.remove('win-1')).not.toThrow();
        expect(windows.isWorkbenchSender(webContents)).toBe(false);
    });

    it('lists the primary window first and resolves senders to keys', () => {
        const windows = new WorkbenchWindows();
        const tearOff = fakeWindow();
        const primary = fakeWindow();
        windows.add('win-1', tearOff);
        windows.add('main', primary);
        expect(windows.list().map(({ key }) => key)).toEqual(['main', 'win-1']);
        expect(windows.keyOf(tearOff.webContents)).toBe('win-1');
        expect(windows.isWorkbenchSender(primary.webContents)).toBe(true);
        expect(windows.isWorkbenchSender({ send: vi.fn() })).toBe(false);
    });

    it('stops trusting a removed window unless the quit path keeps it', () => {
        const windows = new WorkbenchWindows();
        const tearOff = fakeWindow();
        const primary = fakeWindow();
        windows.add('win-1', tearOff);
        windows.add('main', primary);
        windows.remove('win-1');
        windows.remove('main', { keepSenderTrust: true });
        expect(windows.isWorkbenchSender(tearOff.webContents)).toBe(false);
        expect(windows.isWorkbenchSender(primary.webContents)).toBe(true);
        expect(windows.list()).toEqual([]);
    });

    it('prefers the focused window and falls back to the primary', () => {
        const windows = new WorkbenchWindows();
        const primary = fakeWindow();
        const tearOff = fakeWindow({ focused: true });
        windows.add('main', primary);
        windows.add('win-1', tearOff);
        expect(windows.focusedOrPrimary()).toBe(tearOff);
        const idle = new WorkbenchWindows();
        idle.add('main', primary);
        idle.add('win-1', fakeWindow());
        expect(idle.focusedOrPrimary()).toBe(primary);
    });
});

describe('createWorkbenchEventDelivery', () => {
    const settings = { event: 'settings.changed' } as never;
    const command = { event: 'command.execute' } as never;
    const unsaved = { event: 'editor.unsavedRequest' } as never;

    function setup() {
        const windows = new WorkbenchWindows();
        const primary = fakeWindow();
        const tearOff = fakeWindow({ focused: true });
        windows.add('main', primary);
        windows.add('win-1', tearOff);
        return { deliver: createWorkbenchEventDelivery(windows, eventAudience), primary, tearOff };
    }

    it('broadcasts shared state to every window', () => {
        const { deliver, primary, tearOff } = setup();
        deliver({ id: 1 }, settings);
        expect(primary.send).toHaveBeenCalledOnce();
        expect(tearOff.send).toHaveBeenCalledOnce();
    });

    it('sends a one-shot command to the focused window only', () => {
        const { deliver, primary, tearOff } = setup();
        deliver({ id: 1 }, command);
        expect(primary.send).not.toHaveBeenCalled();
        expect(tearOff.send).toHaveBeenCalledOnce();
    });

    it('lets an explicit window key win over the audience', () => {
        const { deliver, primary, tearOff } = setup();
        deliver({ id: 1 }, unsaved, 'win-1');
        deliver({ id: 2 }, settings, 'main');
        expect(tearOff.send).toHaveBeenCalledOnce();
        expect(primary.send).toHaveBeenCalledOnce();
    });
});

describe('EVENT_AUDIENCE', () => {
    it('keeps window-directed events off the broadcast path', () => {
        expect(EVENT_AUDIENCE['command.execute']).toBe('focused');
        expect(EVENT_AUDIENCE['window.fullScreen']).toBe('target');
        expect(EVENT_AUDIENCE['terminal.output']).toBe('all');
    });
});
