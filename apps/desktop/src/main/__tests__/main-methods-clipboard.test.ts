import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
    read: vi.fn<
        () => Promise<Array<{ types: string[]; getType: (type: string) => Promise<Blob> }>>
    >(() => Promise.resolve([])),
    write: vi.fn<(items: unknown[]) => Promise<void>>(() => Promise.resolve()),
    writeText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
    clipboard: { read: electron.read, write: electron.write, writeText: electron.writeText },
    ClipboardItem: class {
        constructor(readonly items: Record<string, string>) {}
    },
    dialog: {},
    nativeImage: {},
    shell: {},
}));

import { fileUriListPaths } from '../clipboard/clipboard-methods';
import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
import type { DesktopServerConnection } from '../server-connection';
import type { UpdateService } from '../updates/updates';
import type { createWorkbenchRootAuthority } from '../workbench-root-authority';

const handle = createMainMethodHandler({
    getCaxriBot: vi.fn(),
    revealSessionInWorkbench: () => Promise.resolve(),
    openSettingsInWorkbench: () => Promise.resolve(),
    getProcessExplorer: () => ({}) as ProcessExplorerWindowController,
    getRemoteDebugging: () => ({ port: '9223', transport: 'port' }) as const,
    getUserDataPath: () => '/user-data',
    getSupervisor: () => ({}) as DesktopServerConnection,
    getUpdateService: () => ({}) as UpdateService,
    getWindow: () => {},
    workbenchRootAuthority: {} as ReturnType<typeof createWorkbenchRootAuthority>,
});

beforeEach(() => {
    electron.write.mockClear();
    electron.writeText.mockClear();
});

describe('Main clipboard writes', () => {
    it('writes plain text through Main, which needs no document focus', async () => {
        await expect(
            handle({ method: 'clipboard.write', params: { text: 'claude --resume id' } }),
        ).resolves.toBeNull();
        expect(electron.writeText).toHaveBeenCalledExactlyOnceWith('claude --resume id');
        expect(electron.write).not.toHaveBeenCalled();
    });

    it('commits the text and HTML flavors in one clipboard item', async () => {
        await handle({
            method: 'clipboard.write',
            params: { text: '| a |', html: '<table></table>' },
        });
        expect(electron.write).toHaveBeenCalledExactlyOnceWith([
            { items: { 'text/plain': '| a |', 'text/html': '<table></table>' } },
        ]);
        expect(electron.writeText).not.toHaveBeenCalled();
    });
});

describe('Main clipboard file paths', () => {
    it('reads every file Finder copied from the URI list', async () => {
        electron.read.mockResolvedValueOnce([
            {
                types: ['text/uri-list'],
                getType: () =>
                    Promise.resolve(new Blob(['file:///tmp/a%20b.txt\r\nfile:///tmp/folder\r\n'])),
            },
        ]);
        await expect(
            handle({ method: 'clipboard.readFilePaths', params: {} }),
        ).resolves.toStrictEqual({ paths: ['/tmp/a b.txt', '/tmp/folder'] });
    });

    it('answers no paths when the clipboard holds no file list', async () => {
        electron.read.mockResolvedValueOnce([
            { types: ['text/plain'], getType: () => Promise.resolve(new Blob(['x'])) },
        ]);
        await expect(
            handle({ method: 'clipboard.readFilePaths', params: {} }),
        ).resolves.toStrictEqual({ paths: [] });
    });

    it('ignores web links and comment lines in a URI list', () => {
        expect(
            fileUriListPaths('# comment\r\nhttps://example.com/a\r\nfile:///tmp/a.txt'),
        ).toStrictEqual(['/tmp/a.txt']);
    });
});
