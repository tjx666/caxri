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

const { buildContextMenuTemplate, showContextMenu } = await import('../context-menu');

function fakeWindow(zoomFactor = 1): BrowserWindow {
    return { webContents: { getZoomFactor: () => zoomFactor } } as unknown as BrowserWindow;
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
});

describe('showContextMenu', () => {
    it('pops at the pointer converted from CSS pixels through the zoom factor', async () => {
        const result = showContextMenu(
            fakeWindow(1.2),
            { items: [{ type: 'item', id: 7, label: 'Rename' }], position: { x: 100, y: 50 } },
            { isE2E: false },
        );
        const [options] = electron.popup.mock.calls[0];
        expect(options).toMatchObject({ x: 120, y: 60 });

        const [template] = electron.buildFromTemplate.mock.calls[0];
        (template[0].click as () => void)();
        options.callback?.();
        await expect(result).resolves.toEqual({ selectedId: 7 });
    });

    it('reports no selection when the menu closes without a choice', async () => {
        const result = showContextMenu(
            fakeWindow(),
            { items: [{ type: 'item', id: 0, label: 'Rename' }] },
            { isE2E: false },
        );
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
        globalThis.caxriE2EContextMenu?.choose(0);
        await expect(second).resolves.toEqual({ selectedId: 0 });
        expect(globalThis.caxriE2EContextMenu).toBeUndefined();
    });
});
