import { EventEmitter } from 'node:events';

import type { BrowserWindow, Menu, MenuItem } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { createSshHostWindowMenu } from '../local-workbench-environment';
import { buildAppMenuTemplate } from '../menu';
import type { SshHostEnvironments } from '../ssh/host-environments';

vi.mock('electron', () => ({}));

/**
 * A stand-in for the built Electron menu: `getMenuItemById` over the template's command items, each with a mutable
 * `enabled` flag like `MenuItem`.
 */
function fakeMenu() {
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
    const items = new Map<string, { enabled: boolean }>();
    const templateItems = template.flatMap((menu) =>
        Array.isArray(menu.submenu) ? menu.submenu : [],
    );
    for (const item of templateItems) if (item.id) items.set(item.id, { enabled: true });
    const menu = {
        getMenuItemById: (id: string) => (items.get(id) as MenuItem | undefined) ?? null,
    } as unknown as Menu;
    return { enabled: (id: string) => items.get(`command.${id}`)?.enabled, menu };
}

function harness() {
    // eslint-disable-next-line unicorn/prefer-event-target -- stands in for Electron's `app`, an EventEmitter
    const app = new EventEmitter();
    const localWindow = {} as BrowserWindow;
    const sshWindow = {} as BrowserWindow;
    let focused: BrowserWindow | null = localWindow;
    const { enabled, menu } = fakeMenu();
    let installed: Menu | null = null;
    const environments = {
        forWindow: (window: BrowserWindow | undefined) =>
            window === sshWindow ? { sendEvent: vi.fn() } : undefined,
    } as unknown as SshHostEnvironments;
    const sshHostWindowMenu = createSshHostWindowMenu(() => environments, {
        app: app as never,
        applicationMenu: () => installed,
        focusedWindow: () => focused,
        setApplicationMenu: (next) => {
            installed = next;
        },
    });
    return {
        app,
        enabled,
        focus: (window: BrowserWindow | null) => {
            focused = window;
            app.emit('browser-window-focus', {}, window);
        },
        localWindow,
        menu,
        sshHostWindowMenu,
        sshWindow,
    };
}

describe('remote window menu', () => {
    it('disables local-machine-only items while an SSH Host window is focused and restores them for a local window', () => {
        const { enabled, focus, localWindow, menu, sshHostWindowMenu, sshWindow } = harness();
        sshHostWindowMenu.setApplicationMenu(menu);

        expect(enabled('diagnostics.export')).toBe(true);
        focus(sshWindow);
        expect(enabled('diagnostics.export')).toBe(false);
        expect(enabled('processExplorer.open')).toBe(false);
        // Open File by Path browses the SSH Host's Project through the remote Server, so it stays enabled.
        expect(enabled('pathBrowser.open')).toBe(true);
        expect(enabled('commandPalette.open')).toBe(true);
        expect(enabled('sshHost.connect')).toBe(true);

        focus(localWindow);
        expect(enabled('diagnostics.export')).toBe(true);
        expect(enabled('processExplorer.open')).toBe(true);
    });

    it('re-enables the items when the SSH Host window loses focus without another window taking it', () => {
        const { app, enabled, focus, menu, sshHostWindowMenu, sshWindow } = harness();
        sshHostWindowMenu.setApplicationMenu(menu);
        focus(sshWindow);

        app.emit('browser-window-blur', {}, sshWindow);

        expect(enabled('diagnostics.export')).toBe(true);
    });

    it('applies the focused SSH Host window to a menu rebuilt while it is focused', () => {
        const { enabled, focus, menu, sshHostWindowMenu, sshWindow } = harness();
        focus(sshWindow);

        sshHostWindowMenu.setApplicationMenu(menu);

        expect(enabled('developer.reportBug')).toBe(false);
        expect(enabled('commandPalette.open')).toBe(true);
    });
});
