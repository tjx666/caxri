import { Buffer } from 'node:buffer';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
    read: vi.fn<
        () => Promise<Array<{ types: string[]; getType: (type: string) => Promise<Blob> }>>
    >(() => Promise.resolve([])),
    write: vi.fn<(items: unknown[]) => Promise<void>>(() => Promise.resolve()),
    writeText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()),
    createFromDataURL:
        vi.fn<(dataUrl: string) => { isEmpty: () => boolean; toPNG: () => Buffer }>(),
}));

vi.mock('electron', () => ({
    clipboard: { read: electron.read, write: electron.write, writeText: electron.writeText },
    ClipboardItem: class {
        constructor(readonly items: Record<string, unknown>) {}
    },
    dialog: {},
    nativeImage: { createFromDataURL: electron.createFromDataURL },
    shell: {},
}));

import { fileUriListPaths } from '../clipboard/clipboard-methods';
import type { DesktopServerConnection } from '../connection/server-connection';
import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer/window';
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

describe('Main clipboard images', () => {
    it('writes a decoded image as PNG, whatever format it arrived in', async () => {
        electron.createFromDataURL.mockReturnValueOnce({
            isEmpty: () => false,
            toPNG: () => Buffer.from([0x89, 0x50]),
        });
        await expect(
            handle({
                method: 'clipboard.writeImage',
                params: { dataUrl: 'data:image/jpeg;base64,/9j/' },
            }),
        ).resolves.toBeNull();
        expect(electron.createFromDataURL).toHaveBeenCalledExactlyOnceWith(
            'data:image/jpeg;base64,/9j/',
        );
        const [[[item]]] = electron.write.mock.calls as unknown as [
            [[{ items: { 'image/png': Blob } }]],
        ];
        expect(Object.keys(item.items)).toStrictEqual(['image/png']);
        expect([...new Uint8Array(await item.items['image/png'].arrayBuffer())]).toStrictEqual([
            0x89, 0x50,
        ]);
    });

    it('refuses a payload that does not decode, leaving the clipboard alone', async () => {
        electron.createFromDataURL.mockReturnValueOnce({
            isEmpty: () => true,
            toPNG: () => Buffer.alloc(0),
        });
        await expect(
            handle({
                method: 'clipboard.writeImage',
                params: { dataUrl: 'data:image/png;base64,AA' },
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(electron.write).not.toHaveBeenCalled();
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
