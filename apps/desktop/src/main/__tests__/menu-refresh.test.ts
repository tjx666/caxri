import type { Keybinding } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { mainLocale, setMainLanguage } from '../locale';
import { buildAppMenuTemplate } from '../menu';
import { createMenuRefreshController, createMenuStateLoader } from '../menu-refresh';

function copyBinding(key: string): Keybinding[] {
    return [{ command: 'terminal.copy', key }];
}

function terminalCopyLabel(keybindings: Keybinding[]): string | undefined {
    const template = buildAppMenuTemplate({
        dispatchCommand: vi.fn(),
        keybindings,
        openAgentCommander: vi.fn(),
        openProcessExplorer: vi.fn(),
        workbenchWindow: vi.fn(),
        focusWorkbench: vi.fn(),
        isFollowingAppZoom: () => false,
    });
    const terminalMenu = template.find((item) => item.label === 'Terminal');
    const submenu = terminalMenu?.submenu;
    if (!Array.isArray(submenu)) throw new Error('Terminal menu is unavailable');
    return submenu.find((item) => item.id === 'command.terminal.copy')?.label;
}

describe('Main menu refresh controller', () => {
    it('preserves the installed hint after a read failure and converges on recovery', async () => {
        const responses = [
            copyBinding('cmd+c'),
            new Error('Host unavailable'),
            copyBinding('cmd+k'),
        ];
        let installedLabel: string | undefined;
        const controller = createMenuRefreshController({
            applyKeybindings: (keybindings) => {
                installedLabel = terminalCopyLabel(keybindings);
            },
            loadKeybindings: () => {
                const response = responses.shift();
                if (response instanceof Error) return Promise.reject(response);
                if (!response) throw new Error('Unexpected menu refresh');
                return Promise.resolve(response);
            },
        });

        await controller.refresh();
        expect(installedLabel).toBe('Copy Selection [⌘C]');

        await controller.refresh();
        expect(installedLabel).toBe('Copy Selection [⌘C]');

        await controller.refresh();
        expect(installedLabel).toBe('Copy Selection [⌘K]');
    });

    it('coalesces an overlapping request into one trailing refresh', async () => {
        const first = Promise.withResolvers<Keybinding[]>();
        const loadKeybindings = vi
            .fn<() => Promise<Keybinding[]>>()
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce(copyBinding('cmd+shift+c'));
        const applied: string[] = [];
        const controller = createMenuRefreshController({
            applyKeybindings: (keybindings) => {
                applied.push(terminalCopyLabel(keybindings) ?? 'missing');
            },
            loadKeybindings,
        });

        const firstRefresh = controller.refresh();
        const overlappingRefresh = controller.refresh();
        first.resolve(copyBinding('cmd+c'));
        await Promise.all([firstRefresh, overlappingRefresh]);

        expect(loadKeybindings).toHaveBeenCalledTimes(2);
        expect(applied).toEqual(['Copy Selection [⌘C]', 'Copy Selection [⇧⌘C]']);
    });

    it('applies the language setting with each menu read', async () => {
        const request = vi.fn((method: string) =>
            Promise.resolve(
                method === 'settings.get'
                    ? { value: { 'workbench.language': null } }
                    : { value: copyBinding('cmd+c') },
            ),
        );
        const load = createMenuStateLoader(
            () => ({ request }) as never,
            () => ['zh-CN'],
        );

        expect(await load()).toEqual(copyBinding('cmd+c'));
        expect(mainLocale()).toBe('zh-CN');
        setMainLanguage(null, []);
    });
});
