import { constants } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { atomicWrite } from '../atomic-file';

const fileSystem = vi.hoisted(() => ({
    directory: {
        close: vi.fn(),
        sync: vi.fn(),
    },
    file: {
        close: vi.fn(),
        sync: vi.fn(),
        writeFile: vi.fn(),
    },
    mkdir: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    return {
        ...actual,
        mkdir: fileSystem.mkdir,
        open: fileSystem.open,
        rename: fileSystem.rename,
        rm: fileSystem.rm,
    };
});

beforeEach(() => {
    vi.clearAllMocks();
    fileSystem.mkdir.mockResolvedValue(undefined);
    fileSystem.open
        .mockResolvedValueOnce(fileSystem.file)
        .mockResolvedValueOnce(fileSystem.directory);
    fileSystem.file.close.mockResolvedValue(undefined);
    fileSystem.file.sync.mockResolvedValue(undefined);
    fileSystem.file.writeFile.mockResolvedValue(undefined);
    fileSystem.rename.mockResolvedValue(undefined);
    fileSystem.directory.close.mockResolvedValue(undefined);
    fileSystem.directory.sync.mockResolvedValue(undefined);
    fileSystem.rm.mockResolvedValue(undefined);
});

describe('atomicWrite', () => {
    it('flushes an exclusive temporary file and its directory before cleanup', async () => {
        const path = '/runtime/settings.json';

        await atomicWrite(path, '{"theme":"dark"}', 0o700);

        expect(fileSystem.mkdir).toHaveBeenCalledWith('/runtime', { recursive: true });
        expect(fileSystem.open).toHaveBeenNthCalledWith(
            1,
            expect.stringMatching(/^\/runtime\/settings\.json\..+\.tmp$/),
            'wx',
            0o700,
        );
        expect(fileSystem.file.writeFile).toHaveBeenCalledWith('{"theme":"dark"}', 'utf8');
        expect(fileSystem.file.sync).toHaveBeenCalledOnce();
        expect(fileSystem.file.close).toHaveBeenCalledOnce();
        expect(fileSystem.rename).toHaveBeenCalledWith(
            expect.stringMatching(/^\/runtime\/settings\.json\..+\.tmp$/),
            path,
        );
        expect(fileSystem.open).toHaveBeenNthCalledWith(2, '/runtime', constants.O_RDONLY);
        expect(fileSystem.directory.sync).toHaveBeenCalledOnce();
        expect(fileSystem.directory.close).toHaveBeenCalledOnce();
        expect(fileSystem.rm).toHaveBeenCalledWith(
            expect.stringMatching(/^\/runtime\/settings\.json\..+\.tmp$/),
            { force: true },
        );
    });

    it('closes and removes the temporary file when writing fails', async () => {
        fileSystem.file.writeFile.mockRejectedValueOnce(new Error('disk full'));

        await expect(atomicWrite('/runtime/settings.json', '{}')).rejects.toThrow('disk full');

        expect(fileSystem.open).toHaveBeenCalledWith(
            expect.stringMatching(/^\/runtime\/settings\.json\..+\.tmp$/),
            'wx',
            0o600,
        );
        expect(fileSystem.file.close).toHaveBeenCalledOnce();
        expect(fileSystem.rename).not.toHaveBeenCalled();
        expect(fileSystem.directory.sync).not.toHaveBeenCalled();
        expect(fileSystem.rm).toHaveBeenCalledWith(
            expect.stringMatching(/^\/runtime\/settings\.json\..+\.tmp$/),
            { force: true },
        );
    });
});
