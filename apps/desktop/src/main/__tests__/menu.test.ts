import { commandDefinitions, defaultKeybindings } from '@caxri/protocol';
import type { BaseWindow, MenuItem, MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    it('keeps target-dependent Project deletion out of the native menu', () => {
        const template = buildAppMenuTemplate({
            keybindings: [],
            dispatchCommand: vi.fn(),
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
        });

        expect(submenu(template, 'Project').map((item) => item.id)).not.toContain(
            'command.project.delete',
        );
    });

    it('derives every command-backed item and label from the shared catalog', () => {
        const template = buildAppMenuTemplate({
            keybindings: [],
            dispatchCommand: vi.fn(),
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
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

    it('opens Agent Commander in Main and leaves Stop to the Workbench, which asks before a running turn ends', () => {
        const dispatchCommand = vi.fn();
        const openAgentCommander = vi.fn();
        const template = buildAppMenuTemplate({
            keybindings: [],
            dispatchCommand,
            openAgentCommander,
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
        });
        const view = submenu(template, 'View');
        const click = (id: string) =>
            view
                .find((item) => item.id === id)
                ?.click?.({} as MenuItem, undefined, { triggeredByAccelerator: false });

        click('command.agentCommander.open');
        click('command.agentCommander.stop');

        expect(openAgentCommander).toHaveBeenCalledOnce();
        expect(dispatchCommand).toHaveBeenCalledExactlyOnceWith('agentCommander.stop', false);
    });

    describe('while another Caxri window is focused', () => {
        const workbench = {};
        const commander = { close: vi.fn() };
        const focusWorkbench = vi.fn();
        function menuItem(menu: string, id: string) {
            const dispatchCommand = vi.fn();
            const template = buildAppMenuTemplate({
                keybindings: defaultKeybindings,
                dispatchCommand,
                openAgentCommander: vi.fn(),
                openBenchmark: vi.fn(),
                openProcessExplorer: vi.fn(),
                workbenchWindow: () => workbench as BaseWindow,
                focusWorkbench,
                isFollowingAppZoom: (window) => Object.is(window, commander),
            });
            const item = submenu(template, menu).find((candidate) => candidate.id === id);
            if (!item?.click) throw new Error(`Missing ${id}`);
            const click = item.click;
            return {
                dispatchCommand,
                press: () =>
                    click({} as MenuItem, commander as unknown as BaseWindow, {
                        triggeredByAccelerator: true,
                    }),
                select: () =>
                    click({} as MenuItem, commander as unknown as BaseWindow, {
                        triggeredByAccelerator: false,
                    }),
            };
        }

        beforeEach(() => vi.clearAllMocks());

        it('closes that window, not a Workbench tab, on Close Tab', () => {
            const { dispatchCommand, press } = menuItem(
                'Window',
                'command.workbench.closeActiveTab',
            );

            press();

            expect(commander.close).toHaveBeenCalledOnce();
            expect(dispatchCommand).not.toHaveBeenCalled();
        });

        it('drops a shortcut typed there instead of running it on the hidden Workbench', () => {
            const { dispatchCommand, press } = menuItem('Terminal', 'command.terminal.new');

            press();

            expect(dispatchCommand).not.toHaveBeenCalled();
            expect(focusWorkbench).not.toHaveBeenCalled();
        });

        it('zooms from the Commander without bringing the Workbench forward', () => {
            const { dispatchCommand, press, select } = menuItem('View', 'command.view.zoomIn');

            press();
            select();

            expect(dispatchCommand.mock.calls).toEqual([
                ['view.zoomIn', true],
                ['view.zoomIn', false],
            ]);
            expect(focusWorkbench).not.toHaveBeenCalled();
        });

        it('still opens Settings in the Workbench from its shortcut', () => {
            const { dispatchCommand, press } = menuItem('Caxri', 'command.settings.open');

            press();

            expect(focusWorkbench).toHaveBeenCalledOnce();
            expect(dispatchCommand).toHaveBeenCalledWith('settings.open', true);
        });

        it('brings the Workbench forward before running a menu item picked with the pointer', () => {
            const { dispatchCommand, select } = menuItem('Terminal', 'command.terminal.new');

            select();

            expect(focusWorkbench).toHaveBeenCalledOnce();
            expect(dispatchCommand).toHaveBeenCalledWith('terminal.new', false);
        });
    });

    it('uses configured accelerators and preserves accelerator-aware dispatch', () => {
        const dispatchCommand = vi.fn();
        const template = buildAppMenuTemplate({
            keybindings: [
                { command: 'terminal.new', key: 'cmd+t', when: 'terminalFocus' },
                { command: 'terminal.new', key: 'cmd+shift+t' },
            ],
            dispatchCommand,
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
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
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
        });
        const item = submenu(template, 'Terminal').find(
            (candidate) => candidate.id === 'command.terminal.clear',
        );

        expect(item?.accelerator).toBeUndefined();
    });

    /**
     * A native accelerator fires from the keystroke itself, so registering one on a chord that opens a sequence would
     * consume `Cmd+K` before the Renderer's chord state machine could arm; the whole `Cmd+K …` family would stop
     * working the moment any command claimed the bare opener.
     */
    it('leaves a chord that opens a sequence to the Renderer instead of registering an accelerator', () => {
        const template = buildAppMenuTemplate({
            keybindings: [
                { command: 'terminal.new', key: 'cmd+k' },
                { command: 'settings.openKeybindings', key: 'cmd+k cmd+s' },
            ],
            dispatchCommand: vi.fn(),
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
        });
        const item = submenu(template, 'Terminal').find(
            (candidate) => candidate.id === 'command.terminal.new',
        );

        expect(item?.accelerator).toBeUndefined();
    });

    /**
     * Electron accelerators are one key combination, so a sequence has no accelerator form. The menu still has to tell
     * the user which keys run the command, which is what the label hint is for.
     */
    it('advertises a sequence as a label hint because it has no accelerator form', () => {
        const template = buildAppMenuTemplate({
            keybindings: [{ command: 'terminal.new', key: 'cmd+k t' }],
            dispatchCommand: vi.fn(),
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
        });
        const item = submenu(template, 'Terminal').find(
            (candidate) => candidate.id === 'command.terminal.new',
        );

        expect(item?.label).toBe('New Terminal [⌘K T]');
        expect(item?.accelerator).toBeUndefined();
    });

    /**
     * A binding without `when` would otherwise earn a native accelerator, which Main drops while the Agent Commander
     * window is focused even though that window runs these Terminal actions itself.
     */
    it.each([
        'terminal.clear',
        'terminal.find',
        'terminal.openDetectedLink',
        'terminal.restart',
    ] as const)('leaves %s shortcuts to the focused Renderer surface', (command) => {
        const template = buildAppMenuTemplate({
            keybindings: [{ command, key: 'cmd+alt+l' }],
            dispatchCommand: vi.fn(),
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
        });
        const item = submenu(template, 'Terminal').find(
            (candidate) => candidate.id === `command.${command}`,
        );
        expect(item).toBeDefined();
        expect(item?.accelerator).toBeUndefined();
    });

    it('leaves contextual Terminal copy to the focused Renderer surface', () => {
        const dispatchCommand = vi.fn();
        const template = buildAppMenuTemplate({
            keybindings: [{ command: 'terminal.copy', key: 'cmd+c' }],
            dispatchCommand,
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
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
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
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
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
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
        // accelerator while the Renderer's own DOM shortcut keeps firing: the failure is invisible from the Renderer.
        const template = buildAppMenuTemplate({
            keybindings: [
                { command: 'session.navigateBack', key: 'ctrl+alt+arrowleft' },
                { command: 'session.navigateForward', key: 'ctrl+alt+arrowright' },
                { command: 'terminal.previousCommand', key: 'cmd+shift+arrowup' },
                { command: 'terminal.nextCommand', key: 'cmd+shift+arrowdown' },
            ],
            dispatchCommand: vi.fn(),
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
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
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer,
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
        });
        const item = submenu(template, 'Help').find(
            (candidate) => candidate.id === 'command.processExplorer.open',
        );

        item?.click?.({} as MenuItem, undefined, {});
        expect(openProcessExplorer).toHaveBeenCalledOnce();
        expect(dispatchCommand).not.toHaveBeenCalled();
    });

    it('offers Report Bug to Agent above Export Diagnostics with its default accelerator', () => {
        const template = buildAppMenuTemplate({
            keybindings: defaultKeybindings,
            dispatchCommand: vi.fn(),
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
        });
        const help = submenu(template, 'Help');

        expect(help.map((item) => item.id ?? item.type)).toEqual([
            'command.processExplorer.open',
            'separator',
            'command.developer.reportBug',
            'command.diagnostics.export',
        ]);
        expect(help.find((item) => item.id === 'command.developer.reportBug')?.accelerator).toBe(
            'Command+Shift+B',
        );
    });

    it('registers the Window and Help menus with their AppKit roles and translated labels', () => {
        const template = buildAppMenuTemplate({
            keybindings: [],
            dispatchCommand: vi.fn(),
            openAgentCommander: vi.fn(),
            openBenchmark: vi.fn(),
            openProcessExplorer: vi.fn(),
            workbenchWindow: vi.fn(),
            focusWorkbench: vi.fn(),
            isFollowingAppZoom: () => false,
        });

        expect(template.find((item) => item.label === 'Window')?.role).toBe('windowMenu');
        expect(template.find((item) => item.label === 'Help')?.role).toBe('help');
    });
});
