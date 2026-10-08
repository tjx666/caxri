import type { BrowserWindow, MenuItemConstructorOptions, PopupOptions } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
    const popup = vi.fn<(options: PopupOptions) => void>();
    return {
        popup,
        buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => ({ template, popup })),
    };
});

vi.mock('electron', () => ({ Menu: { buildFromTemplate: electron.buildFromTemplate } }));

const { buildContextMenuTemplate, showContextMenu, canShowMenuSublabel } =
    await import('../context-menu');

function fakeWindow(
    zoomFactor = 1,
    executeJavaScript: (code: string) => Promise<unknown> = () => Promise.resolve(),
): BrowserWindow {
    return {
        webContents: { executeJavaScript, getZoomFactor: () => zoomFactor },
    } as unknown as BrowserWindow;
}

/**
 * Follows a menu promise so a test can assert it has not settled yet.
 */
function track<T>(promise: Promise<T>): { isSettled: () => boolean; settled: Promise<T> } {
    let isSettled = false;
    const settled = (async () => {
        const value = await promise;
        isSettled = true;
        return value;
    })();
    return { isSettled: () => isSettled, settled };
}

afterEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(globalThis, 'caxriE2EContextMenu');
});

describe('buildContextMenuTemplate', () => {
    it('shows a single-chord shortcut as an unregistered accelerator and reports the chosen id', () => {
        const onSelect = vi.fn();
        const [item] = buildContextMenuTemplate(
            [{ type: 'item', id: 4, label: 'Copy', shortcut: 'cmd+c' }],
            onSelect,
        );

        expect(item).toMatchObject({
            label: 'Copy',
            enabled: true,
            accelerator: 'Command+C',
            registerAccelerator: false,
        });
        (item.click as () => void)();
        expect(onSelect).toHaveBeenCalledWith(4);
    });

    it('appends a chord sequence to the label because an accelerator cannot express it', () => {
        const [item] = buildContextMenuTemplate(
            [{ type: 'item', id: 0, label: 'Copy Path', shortcut: 'cmd+k cmd+c' }],
            vi.fn(),
        );

        expect(item.accelerator).toBeUndefined();
        expect(item.label).toMatch(/^Copy Path \[.+\]$/);
    });

    it('keeps separators, disabled entries, and nested submenus', () => {
        const onSelect = vi.fn();
        const template = buildContextMenuTemplate(
            [
                { type: 'item', id: 0, label: 'Paste', enabled: false },
                { type: 'separator' },
                {
                    type: 'submenu',
                    label: 'Share',
                    submenu: [{ type: 'item', id: 1, label: 'Copy Link' }],
                },
            ],
            onSelect,
        );

        expect(template[0]).toMatchObject({ label: 'Paste', enabled: false });
        expect(template[1]).toEqual({ type: 'separator' });
        const nested = template[2].submenu as MenuItemConstructorOptions[];
        (nested[0].click as () => void)();
        expect(onSelect).toHaveBeenCalledWith(1);
    });

    it('shows why a disabled entry or submenu is unavailable as its sublabel', () => {
        const template = buildContextMenuTemplate(
            [
                {
                    type: 'item',
                    id: 0,
                    label: 'Paste',
                    enabled: false,
                    disabledReason: 'Nothing to paste',
                },
                {
                    type: 'submenu',
                    label: 'Open With',
                    enabled: false,
                    disabledReason: 'No app can open this file',
                    submenu: [{ type: 'item', id: 1, label: 'Preview' }],
                },
            ],
            vi.fn(),
            { canShowSublabel: true },
        );

        expect(template[0]).toMatchObject({
            label: 'Paste',
            enabled: false,
            sublabel: 'Nothing to paste',
        });
        expect(template[1]).toMatchObject({
            label: 'Open With',
            enabled: false,
            sublabel: 'No app can open this file',
        });
    });

    it('shows a reason shared by adjacent disabled entries once, until a separator', () => {
        const reason = 'This document is outside every added Project';
        const template = buildContextMenuTemplate(
            [
                {
                    type: 'item',
                    id: 0,
                    label: 'Reveal in Finder',
                    enabled: false,
                    disabledReason: reason,
                },
                {
                    type: 'item',
                    id: 1,
                    label: 'Open in Terminal',
                    enabled: false,
                    disabledReason: reason,
                },
                {
                    type: 'item',
                    id: 2,
                    label: 'Copy Agent Session ID',
                    enabled: false,
                    disabledReason: 'Unbound',
                },
                { type: 'separator' },
                {
                    type: 'item',
                    id: 3,
                    label: 'Copy Path',
                    enabled: false,
                    disabledReason: 'Unbound',
                },
            ],
            vi.fn(),
        );

        expect(template.map((item) => item.sublabel)).toEqual([
            reason,
            undefined,
            'Unbound',
            undefined,
            'Unbound',
        ]);
    });

    it('never shows a reason on an enabled entry', () => {
        const [item] = buildContextMenuTemplate(
            [{ type: 'item', id: 0, label: 'Paste', disabledReason: 'Nothing to paste' }],
            vi.fn(),
        );

        expect(item).toMatchObject({ label: 'Paste', enabled: true });
        expect(item.sublabel).toBeUndefined();
    });

    it('appends the reason to the label where macOS has no sublabel', () => {
        const [item] = buildContextMenuTemplate(
            [
                {
                    type: 'item',
                    id: 0,
                    label: 'Copy Path',
                    enabled: false,
                    disabledReason: 'This document is outside every added Project',
                    shortcut: 'cmd+k cmd+c',
                },
            ],
            vi.fn(),
            { canShowSublabel: false },
        );

        expect(item.sublabel).toBeUndefined();
        expect(item.label).toMatch(
            /^Copy Path \[.+\]: This document is outside every added Project$/,
        );
    });
});

describe('canShowMenuSublabel', () => {
    it.each([
        ['13.6.7', false],
        ['14.3.1', false],
        ['14.4', true],
        ['14.4.1', true],
        ['15.0', true],
        ['26.1', true],
    ])('macOS %s → %s', (version, expected) => {
        expect(canShowMenuSublabel(version)).toBe(expected);
    });
});

describe('showContextMenu', () => {
    it('pops at the pointer converted from CSS pixels through the zoom factor', async () => {
        const result = showContextMenu(
            fakeWindow(1.2),
            { items: [{ type: 'item', id: 7, label: 'Rename' }], position: { x: 100, y: 50 } },
            { isE2E: false, systemVersion: '15.0' },
        );
        const [options] = electron.popup.mock.calls[0];
        expect(options).toMatchObject({ x: 120, y: 60 });

        const [template] = electron.buildFromTemplate.mock.calls[0];
        (template[0].click as () => void)();
        options.callback?.();
        await expect(result).resolves.toEqual({ selectedId: 7 });
    });

    it('delivers a click only after the menu has closed', async () => {
        vi.useFakeTimers();
        try {
            const result = track(
                showContextMenu(
                    fakeWindow(),
                    { items: [{ type: 'item', id: 3, label: 'Rename' }] },
                    { isE2E: false, systemVersion: '15.0' },
                ),
            );
            const [template] = electron.buildFromTemplate.mock.calls[0];
            (template[0].click as () => void)();
            await vi.runAllTimersAsync();
            expect(result.isSettled()).toBe(false);

            electron.popup.mock.calls[0][0].callback?.();
            expect(result.isSettled()).toBe(false);
            await vi.runAllTimersAsync();
            await expect(result.settled).resolves.toEqual({ selectedId: 3 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('still delivers a click AppKit dispatches after reporting the close, including id 0', async () => {
        const result = showContextMenu(
            fakeWindow(),
            { items: [{ type: 'item', id: 0, label: 'Rename' }] },
            { isE2E: false, systemVersion: '15.0' },
        );
        electron.popup.mock.calls[0][0].callback?.();
        const [template] = electron.buildFromTemplate.mock.calls[0];
        (template[0].click as () => void)();
        await expect(result).resolves.toEqual({ selectedId: 0 });
    });

    it('reports no selection when the menu closes without a choice', async () => {
        const result = showContextMenu(
            fakeWindow(),
            { items: [{ type: 'item', id: 0, label: 'Rename' }] },
            { isE2E: false, systemVersion: '15.0' },
        );
        electron.popup.mock.calls[0][0].callback?.();
        await expect(result).resolves.toEqual({});
    });

    it('falls back to label suffixes on a macOS without sublabels', async () => {
        const result = showContextMenu(
            fakeWindow(),
            {
                items: [
                    {
                        type: 'item',
                        id: 0,
                        label: 'Paste',
                        enabled: false,
                        disabledReason: 'Nothing to paste',
                    },
                ],
            },
            { isE2E: false, systemVersion: '14.3' },
        );
        const [template] = electron.buildFromTemplate.mock.calls[0];
        expect(template[0]).toMatchObject({ label: 'Paste: Nothing to paste', enabled: false });
        electron.popup.mock.calls[0][0].callback?.();
        await expect(result).resolves.toEqual({});
    });

    it('parks E2E menus on the probe instead of popping, and closes a superseded one', async () => {
        const first = showContextMenu(
            fakeWindow(),
            { items: [{ type: 'item', id: 0, label: 'First' }] },
            { isE2E: true },
        );
        const second = showContextMenu(
            fakeWindow(),
            { items: [{ type: 'item', id: 0, label: 'Second' }] },
            { isE2E: true },
        );

        expect(electron.popup).not.toHaveBeenCalled();
        await expect(first).resolves.toEqual({});
        expect(globalThis.caxriE2EContextMenu?.items[0].label).toBe('Second');
        await globalThis.caxriE2EContextMenu?.choose(0);
        await expect(second).resolves.toEqual({ selectedId: 0 });
        expect(globalThis.caxriE2EContextMenu).toBeUndefined();
    });

    it('replays the focus return between the click and the close when a spec asks for it', async () => {
        const refocus = Promise.withResolvers<void>();
        const executeJavaScript = vi.fn(() => refocus.promise);
        const result = track(
            showContextMenu(
                fakeWindow(1, executeJavaScript),
                { items: [{ type: 'item', id: 5, label: 'Rename' }] },
                { isE2E: true },
            ),
        );

        const chosen = globalThis.caxriE2EContextMenu?.choose(5, { refocusOnClose: true });
        expect(executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('.focus('));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(result.isSettled()).toBe(false);

        refocus.resolve();
        await chosen;
        await expect(result.settled).resolves.toEqual({ selectedId: 5 });
    });
});
