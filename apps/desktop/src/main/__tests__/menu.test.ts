import { commandDefinitions } from '@caxri/protocol';
import type { MenuItem, MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { buildAppMenuTemplate } from '../menu';

function submenu(
    template: MenuItemConstructorOptions[],
    label: string,
): MenuItemConstructorOptions[] {
    const value = template.find((item) => item.label === label)?.submenu;
    if (!Array.isArray(value)) throw new Error(`Missing ${label} submenu`);
    return value;
}

describe('application menu', () => {
    it('derives every command-backed item and label from the shared catalog', () => {
        const template = buildAppMenuTemplate({
            keybindings: [],
            dispatchCommand: vi.fn(),
            openProcessExplorer: vi.fn(),
        });
        const actual = template.flatMap((menu) =>
            Array.isArray(menu.submenu)
                ? menu.submenu.filter((item) => item.id?.startsWith('command.'))
                : [],
        );
        const expected = commandDefinitions.filter((command) => command.nativeMenu);

        expect(actual.map((item) => item.id)).toEqual(
            expect.arrayContaining(expected.map((command) => `command.${command.id}`)),
        );
        expect(actual).toHaveLength(expected.length);
        for (const command of expected)
            expect(actual.find((item) => item.id === `command.${command.id}`)?.label).toBe(
                command.title,
            );
    });

    it('uses configured accelerators and preserves accelerator-aware dispatch', () => {
        const dispatchCommand = vi.fn();
        const template = buildAppMenuTemplate({
            keybindings: [
                { command: 'terminal.new', key: 'cmd+t', when: 'terminalFocus' },
                { command: 'terminal.new', key: 'cmd+shift+t' },
            ],
            dispatchCommand,
            openProcessExplorer: vi.fn(),
        });
        const item = submenu(template, 'Terminal').find(
            (candidate) => candidate.id === 'command.terminal.new',
        );

        expect(item?.accelerator).toBe('Command+Shift+T');
        item?.click?.({} as MenuItem, undefined, { triggeredByAccelerator: true });
        expect(dispatchCommand).toHaveBeenCalledWith('terminal.new', true);
    });

    it('leaves a global menu chord to an earlier contextual Renderer binding', () => {
        const template = buildAppMenuTemplate({
            keybindings: [
                {
                    args: { text: '\u{3}' },
                    command: 'workbench.action.terminal.sendSequence',
                    key: 'Command+K',
                    when: 'terminalFocus',
                },
                { command: 'terminal.clear', key: 'cmd+k' },
            ],
            dispatchCommand: vi.fn(),
            openProcessExplorer: vi.fn(),
        });
        const item = submenu(template, 'Terminal').find(
            (candidate) => candidate.id === 'command.terminal.clear',
        );

        expect(item?.accelerator).toBeUndefined();
    });

    it('leaves contextual Terminal copy to the focused Renderer surface', () => {
        const dispatchCommand = vi.fn();
        const template = buildAppMenuTemplate({
            keybindings: [{ command: 'terminal.copy', key: 'cmd+c' }],
            dispatchCommand,
            openProcessExplorer: vi.fn(),
        });
        const item = submenu(template, 'Terminal').find(
            (candidate) => candidate.id === 'command.terminal.copy',
        );

        expect(item?.label).toBe('Copy Selection [⌘C]');
        expect(item?.accelerator).toBeUndefined();
        item?.click?.({} as MenuItem, undefined, { triggeredByAccelerator: false });
        expect(dispatchCommand).toHaveBeenCalledWith('terminal.copy', false);
    });

    it('updates the contextual Terminal copy hint without creating a native accelerator', () => {
        const template = buildAppMenuTemplate({
            keybindings: [{ command: 'terminal.copy', key: 'cmd+shift+c' }],
            dispatchCommand: vi.fn(),
            openProcessExplorer: vi.fn(),
        });
        const item = submenu(template, 'Terminal').find(
            (candidate) => candidate.id === 'command.terminal.copy',
        );

        expect(item).toMatchObject({
            accelerator: undefined,
            label: 'Copy Selection [⇧⌘C]',
        });
    });

    it('omits an empty contextual Terminal copy hint', () => {
        const template = buildAppMenuTemplate({
            keybindings: [{ command: 'terminal.copy', key: '+' }],
            dispatchCommand: vi.fn(),
            openProcessExplorer: vi.fn(),
        });
        const item = submenu(template, 'Terminal').find(
            (candidate) => candidate.id === 'command.terminal.copy',
        );

        expect(item).toMatchObject({
            accelerator: undefined,
            label: 'Copy Selection',
        });
    });

    it('translates DOM key names Electron does not accept as accelerator tokens', () => {
        // `ARROWLEFT` is not an Electron token, so an unmapped arrow silently leaves the menu item without a working
        // accelerator while the Renderer's own DOM shortcut keeps firing — the failure is invisible from the Renderer.
        const template = buildAppMenuTemplate({
            keybindings: [
                { command: 'session.navigateBack', key: 'ctrl+alt+arrowleft' },
                { command: 'session.navigateForward', key: 'ctrl+alt+arrowright' },
                { command: 'terminal.previousCommand', key: 'cmd+shift+arrowup' },
                { command: 'terminal.nextCommand', key: 'cmd+shift+arrowdown' },
            ],
            dispatchCommand: vi.fn(),
            openProcessExplorer: vi.fn(),
        });
        const accelerators = template.flatMap((menu) =>
            Array.isArray(menu.submenu)
                ? menu.submenu.flatMap((item) =>
                      item.id && item.accelerator ? [[item.id, item.accelerator]] : [],
                  )
                : [],
        );

        expect(Object.fromEntries(accelerators)).toMatchObject({
            'command.session.navigateBack': 'Control+Alt+Left',
            'command.session.navigateForward': 'Control+Alt+Right',
            'command.terminal.previousCommand': 'Command+Shift+Up',
            'command.terminal.nextCommand': 'Command+Shift+Down',
        });
    });

    it('keeps Process Explorer opening in Main for its diagnostic window', () => {
        const dispatchCommand = vi.fn();
        const openProcessExplorer = vi.fn();
        const template = buildAppMenuTemplate({
            keybindings: [],
            dispatchCommand,
            openProcessExplorer,
        });
        const item = submenu(template, 'Help').find(
            (candidate) => candidate.id === 'command.processExplorer.open',
        );

        item?.click?.({} as MenuItem, undefined, {});
        expect(openProcessExplorer).toHaveBeenCalledOnce();
        expect(dispatchCommand).not.toHaveBeenCalled();
    });
});
