import type { ServerEvent } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MenuBarModeOptions, MenuBarTray } from '../menu-bar-mode';
import { createMenuBarMode, MENU_BAR_REFRESH_MS } from '../menu-bar-mode';

function setup(overrides: Partial<MenuBarModeOptions> = {}) {
    const tray: MenuBarTray = {
        destroy: vi.fn(),
        setContextMenu: vi.fn(),
        setTitle: vi.fn(),
        setToolTip: vi.fn(),
    };
    const dock = { hide: vi.fn(), show: vi.fn() };
    const write = vi.fn();
    let isWindowOpen = false;
    const options: MenuBarModeOptions = {
        actions: {
            openSession: vi.fn().mockResolvedValue(undefined),
            openWindow: vi.fn(),
            quit: vi.fn(),
            setKeepAwake: vi.fn(),
        },
        createTray: vi.fn(() => tray),
        dock,
        hasOpenWindow: () => isWindowOpen,
        isEnabled: vi.fn().mockResolvedValue(true),
        logger: () => ({ write }) as never,
        readRunning: vi.fn().mockResolvedValue({ chats: 1, terminals: 0 }),
        readSnapshot: vi.fn().mockResolvedValue({
            summary: { working: 1, usageWaiting: 0, attentionCount: 2, attention: [] },
            isKeepingAwake: true,
            isKeepAwakeEnabled: true,
        }),
        showIntroOnce: vi.fn(),
        ...overrides,
    };
    const mode = createMenuBarMode(options);
    return {
        dock,
        mode,
        options,
        openWindow: () => {
            isWindowOpen = true;
        },
        tray,
        lastLog: () => write.mock.calls.at(-1) as unknown[] | undefined,
    };
}

const stateChanged = { event: 'state.changed' } as ServerEvent;
const settingsChanged = { event: 'settings.changed' } as ServerEvent;

describe('createMenuBarMode', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('moves Caxri from the Dock to the menu bar when the window closes with work running', async () => {
        const harness = setup();
        await harness.mode.windowClosed();
        expect(harness.mode.isActive()).toBe(true);
        expect(harness.dock.hide).toHaveBeenCalled();
        expect(harness.options.showIntroOnce).toHaveBeenCalled();
        expect(harness.tray.setTitle).toHaveBeenLastCalledWith('2');
    });

    it('keeps the Dock presence when nothing is running or the setting is off', async () => {
        const idle = setup({ readRunning: vi.fn().mockResolvedValue({ chats: 0, terminals: 0 }) });
        await idle.mode.windowClosed();
        expect(idle.mode.isActive()).toBe(false);

        const off = setup({ isEnabled: vi.fn().mockResolvedValue(false) });
        await off.mode.windowClosed();
        expect(off.mode.isActive()).toBe(false);
        expect(off.dock.hide).not.toHaveBeenCalled();
    });

    it('does not enter when a window reopened while the checks ran', async () => {
        const harness = setup();
        const closing = harness.mode.windowClosed();
        harness.openWindow();
        await closing;
        expect(harness.mode.isActive()).toBe(false);
        expect(harness.options.createTray).not.toHaveBeenCalled();
    });

    it('stays in the Dock when the Server is unreachable', async () => {
        const harness = setup({ readRunning: vi.fn().mockRejectedValue(new Error('down')) });
        await harness.mode.windowClosed();
        expect(harness.mode.isActive()).toBe(false);
    });

    it('coalesces state changes into one redraw', async () => {
        const harness = setup();
        await harness.mode.windowClosed();
        vi.mocked(harness.options.readSnapshot).mockClear();
        for (let index = 0; index < 5; index += 1) harness.mode.observe(stateChanged);
        await vi.advanceTimersByTimeAsync(MENU_BAR_REFRESH_MS);
        expect(harness.options.readSnapshot).toHaveBeenCalledTimes(1);
    });

    it('leaves with the reason the user came back for', async () => {
        const harness = setup();
        await harness.mode.windowClosed();
        harness.mode.windowOpening();
        expect(harness.mode.isActive()).toBe(false);
        expect(harness.tray.destroy).toHaveBeenCalled();
        expect(harness.dock.show).toHaveBeenCalled();
        expect(harness.lastLog()?.[2]).toMatchObject({
            fields: { reason: 'open-window', sessionOpens: 0 },
        });
    });

    it('attributes a reopen to the Session the user picked', async () => {
        const open = Promise.withResolvers<void>();
        const harness = setup();
        vi.mocked(harness.options.actions.openSession).mockReturnValue(open.promise);
        vi.mocked(harness.options.readSnapshot).mockResolvedValue({
            summary: {
                working: 0,
                usageWaiting: 0,
                attentionCount: 1,
                attention: [{ sessionId: 's1', title: 'Fix', projectTitle: 'App', kind: 'result' }],
            },
            isKeepingAwake: false,
            isKeepAwakeEnabled: true,
        });
        await harness.mode.windowClosed();
        const items = vi.mocked(harness.tray.setContextMenu).mock.calls.at(-1)?.[0] ?? [];
        items.find((item) => item.label === 'Fix')?.click?.({} as never, undefined, {});
        harness.mode.windowOpening();
        open.resolve();
        expect(harness.lastLog()?.[2]).toMatchObject({
            fields: { reason: 'open-session', sessionOpens: 1 },
        });
    });

    it('leaves when the setting turns off', async () => {
        const harness = setup();
        await harness.mode.windowClosed();
        vi.mocked(harness.options.isEnabled).mockResolvedValue(false);
        harness.mode.observe(settingsChanged);
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.mode.isActive()).toBe(false);
        expect(harness.lastLog()?.[2]).toMatchObject({ fields: { reason: 'setting-off' } });
    });

    it('removes the status item before quitting', async () => {
        const harness = setup();
        await harness.mode.windowClosed();
        harness.mode.quitting();
        expect(harness.tray.destroy).toHaveBeenCalled();
        expect(harness.lastLog()?.[2]).toMatchObject({ fields: { reason: 'quit' } });
    });
});
