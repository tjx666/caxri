import { Buffer } from 'node:buffer';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_AGENT_CHAT_PICKED_IMAGES_BYTES } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    dialog: { showOpenDialog: vi.fn() },
    shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));
/**
 * Lets one test make `stat` report a small regular file for a path that is really something else, the state a path is
 * in when it is swapped after the pick. Every other path keeps the real `stat`.
 */
const statLie = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    return {
        ...actual,
        stat: ((path: string, ...rest: []) =>
            path === statLie.path
                ? Promise.resolve({ isDirectory: () => false, isFile: () => true, size: 3 })
                : actual.stat(path, ...rest)) as typeof actual.stat,
    };
});
vi.mock('electron', () => ({ dialog: electronMock.dialog, shell: electronMock.shell }));

import { openAgentChatPathReference, selectAgentChatPaths } from '../agent-chat-path-picker';

const fixture = { directory: '' };

beforeEach(async () => {
    electronMock.dialog.showOpenDialog.mockReset();
    electronMock.shell.openPath.mockReset().mockResolvedValue('');
    electronMock.shell.showItemInFolder.mockReset();
    statLie.path = undefined;
    fixture.directory = await mkdtemp(join(tmpdir(), 'caxri-chat-path-picker-'));
});

afterEach(async () => {
    await rm(fixture.directory, { recursive: true, force: true });
});

function pick(...paths: string[]): void {
    electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: paths });
}

describe('selectAgentChatPaths', () => {
    it('opens one panel for several files and folders together', async () => {
        const window = {};
        electronMock.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
        await expect(
            selectAgentChatPaths(window as never, { shouldReadImages: true }),
        ).resolves.toEqual([]);
        expect(electronMock.dialog.showOpenDialog).toHaveBeenCalledWith(
            window,
            expect.objectContaining({
                properties: ['openFile', 'openDirectory', 'multiSelections'],
            }),
        );
    });

    it('returns a folder and a file as paths, and an image with its bytes', async () => {
        const folder = join(fixture.directory, 'src');
        const notes = join(fixture.directory, 'notes.md');
        const image = join(fixture.directory, 'shot.PNG');
        await mkdir(folder);
        await writeFile(notes, 'notes');
        await writeFile(image, Buffer.from([1, 2, 3]));
        pick(folder, notes, image);
        await expect(selectAgentChatPaths(undefined, { shouldReadImages: true })).resolves.toEqual([
            { path: folder, isDirectory: true },
            { path: notes },
            {
                path: image,
                image: {
                    mediaType: 'image/png',
                    base64: Buffer.from([1, 2, 3]).toString('base64'),
                },
            },
        ]);
    });

    it('cites images by path when the provider takes none, or past the pick budget', async () => {
        const image = join(fixture.directory, 'shot.jpg');
        await writeFile(image, Buffer.from([1]));
        pick(image);
        await expect(selectAgentChatPaths(undefined, { shouldReadImages: false })).resolves.toEqual(
            [{ path: image }],
        );

        const large = join(fixture.directory, 'large.webp');
        await writeFile(large, Buffer.alloc(MAX_AGENT_CHAT_PICKED_IMAGES_BYTES));
        pick(large, image);
        const picked = await selectAgentChatPaths(undefined, { shouldReadImages: true });
        // The first image spends the whole budget, so the second is cited by path.
        expect(picked.map((entry) => [entry.path, entry.image?.mediaType])).toEqual([
            [large, 'image/webp'],
            [image, undefined],
        ]);
    });

    it('cites a FIFO named like an image by path without waiting for a writer', async () => {
        const fifo = join(fixture.directory, 'pipe.png');
        await execFileAsync('mkfifo', [fifo]);
        pick(fifo);
        const result = await Promise.race([
            selectAgentChatPaths(undefined, { shouldReadImages: true }),
            new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3000)),
        ]);
        expect(result).toEqual([{ path: fifo }]);
    });

    it('cites a path swapped for a FIFO after it was checked, instead of blocking on it', async () => {
        const fifo = join(fixture.directory, 'swapped.png');
        await execFileAsync('mkfifo', [fifo]);
        statLie.path = fifo;
        pick(fifo);
        const result = await Promise.race([
            selectAgentChatPaths(undefined, { shouldReadImages: true }),
            new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3000)),
        ]);
        if (result === 'blocked') {
            // Release the stuck open so the test process does not keep a thread parked on the FIFO.
            await (await open(fifo, 'r+')).close();
        }
        expect(result).toEqual([{ path: fifo }]);
    });

    it('cites an image one byte past the budget by path', async () => {
        const image = join(fixture.directory, 'big.png');
        await writeFile(image, Buffer.alloc(MAX_AGENT_CHAT_PICKED_IMAGES_BYTES + 1));
        pick(image);
        await expect(selectAgentChatPaths(undefined, { shouldReadImages: true })).resolves.toEqual([
            { path: image },
        ]);
    });

    it('never reads a folder named like an image or a file that vanished', async () => {
        const folder = join(fixture.directory, 'assets.png');
        await mkdir(folder);
        const missing = join(fixture.directory, 'missing.gif');
        pick(folder, missing);
        await expect(selectAgentChatPaths(undefined, { shouldReadImages: true })).resolves.toEqual([
            { path: folder, isDirectory: true },
            { path: missing },
        ]);
    });
});

describe('openAgentChatPathReference', () => {
    it('opens a folder in Finder and reveals a file or an app in its folder', async () => {
        const folder = join(fixture.directory, 'prettier-config.v2');
        const app = join(fixture.directory, 'Tool.app');
        const notes = join(fixture.directory, 'notes.md');
        await mkdir(folder);
        await mkdir(app);
        await writeFile(notes, 'notes');
        await openAgentChatPathReference(folder);
        expect(electronMock.shell.openPath).toHaveBeenCalledWith(folder);
        await openAgentChatPathReference(notes);
        await openAgentChatPathReference(app);
        expect(electronMock.shell.showItemInFolder.mock.calls).toEqual([[notes], [app]]);
        expect(electronMock.shell.openPath).toHaveBeenCalledTimes(1);
    });

    it('reveals a bundle reached through a symlink or known only by its Info.plist', async () => {
        const app = join(fixture.directory, 'Tool.app');
        const link = join(fixture.directory, 'tools');
        const service = join(fixture.directory, 'Helper.service');
        await mkdir(app);
        await symlink(app, link);
        await mkdir(join(service, 'Contents'), { recursive: true });
        await writeFile(join(service, 'Contents', 'Info.plist'), '<plist/>');
        await openAgentChatPathReference(link);
        await openAgentChatPathReference(service);
        expect(electronMock.shell.showItemInFolder.mock.calls).toEqual([[link], [service]]);
        expect(electronMock.shell.openPath).not.toHaveBeenCalled();
    });

    it('reports a path that no longer exists or that Finder cannot open', async () => {
        await expect(
            openAgentChatPathReference(join(fixture.directory, 'gone')),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(electronMock.shell.showItemInFolder).not.toHaveBeenCalled();
        electronMock.shell.openPath.mockResolvedValueOnce('Failed to open');
        await expect(openAgentChatPathReference(fixture.directory)).rejects.toThrow(
            'Failed to open',
        );
    });
});
