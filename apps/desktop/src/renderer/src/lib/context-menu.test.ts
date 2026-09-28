import { describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());

vi.mock('./caxri', () => ({ caxri: { request } }));
vi.mock('../stores/toasts', () => ({ tryCommand: (_label: string, run: () => unknown) => run() }));

const { CONTEXT_MENU_SEPARATOR, serializeContextMenu, showContextMenu } =
    await import('./context-menu');

describe('serializeContextMenu', () => {
    it('drops falsy slots and separators that would render at an edge or doubled', () => {
        const { items } = serializeContextMenu([
            CONTEXT_MENU_SEPARATOR,
            { label: 'Open', onSelect: vi.fn() },
            false,
            CONTEXT_MENU_SEPARATOR,
            undefined,
            CONTEXT_MENU_SEPARATOR,
            { label: 'Delete', onSelect: vi.fn(), disabled: true, shortcut: 'cmd+backspace' },
            CONTEXT_MENU_SEPARATOR,
        ]);

        expect(items).toEqual([
            { type: 'item', id: 0, label: 'Open' },
            { type: 'separator' },
            { type: 'item', id: 1, label: 'Delete', enabled: false, shortcut: 'cmd+backspace' },
        ]);
    });

    it('sends a disabled reason only with a disabled entry', () => {
        const { items } = serializeContextMenu([
            {
                label: 'Paste',
                onSelect: vi.fn(),
                disabled: true,
                disabledReason: 'Nothing to paste',
            },
            { label: 'Duplicate', onSelect: vi.fn(), disabled: false, disabledReason: 'Busy' },
            { label: 'Delete', onSelect: vi.fn(), disabled: true },
            {
                type: 'submenu',
                label: 'Open With',
                disabled: true,
                disabledReason: 'No app can open this file',
                entries: [{ label: 'Preview', onSelect: vi.fn() }],
            },
        ]);

        expect(items).toEqual([
            {
                type: 'item',
                id: 0,
                label: 'Paste',
                enabled: false,
                disabledReason: 'Nothing to paste',
            },
            { type: 'item', id: 1, label: 'Duplicate' },
            { type: 'item', id: 2, label: 'Delete', enabled: false },
            {
                type: 'submenu',
                label: 'Open With',
                enabled: false,
                disabledReason: 'No app can open this file',
                submenu: [{ type: 'item', id: 3, label: 'Preview' }],
            },
        ]);
    });

    it('omits an empty submenu and numbers nested entries in one id space', () => {
        const { items, actions } = serializeContextMenu([
            { type: 'submenu', label: 'Empty', entries: [false] },
            {
                type: 'submenu',
                label: 'Share',
                entries: [{ label: 'Copy Link', onSelect: vi.fn() }],
            },
            { label: 'Rename', onSelect: vi.fn() },
        ]);

        expect(items).toEqual([
            {
                type: 'submenu',
                label: 'Share',
                submenu: [{ type: 'item', id: 0, label: 'Copy Link' }],
            },
            { type: 'item', id: 1, label: 'Rename' },
        ]);
        expect(actions.keys().toArray()).toEqual([0, 1]);
    });
});

describe('showContextMenu', () => {
    it('closes before running the chosen action', async () => {
        const order: string[] = [];
        request.mockResolvedValueOnce({ selectedId: 1 });

        await showContextMenu(
            [
                { label: 'Open', onSelect: () => order.push('open') },
                { label: 'Rename', onSelect: () => order.push('rename') },
            ],
            { x: 10, y: 20 },
            () => order.push('closed'),
        );

        expect(request).toHaveBeenCalledWith('contextMenu.show', {
            items: [
                { type: 'item', id: 0, label: 'Open' },
                { type: 'item', id: 1, label: 'Rename' },
            ],
            position: { x: 10, y: 20 },
        });
        expect(order).toEqual(['closed', 'rename']);
    });
});
