import type { MenuItem, MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { commandDefinitions } from '../../shared/commands';
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

        expect(item?.accelerator).toBeUndefined();
        item?.click?.({} as MenuItem, undefined, { triggeredByAccelerator: false });
        expect(dispatchCommand).toHaveBeenCalledWith('terminal.copy', false);
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
