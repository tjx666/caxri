import { Buffer } from 'node:buffer';
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
    assertPrivateUnixSocketDirectory,
    ensurePrivateUnixSocketDirectory,
    ensureUnixSocketDirectory,
    isWithinUnixSocketLimit,
    MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES,
    unixSocketPath,
} from '../unix-socket-path';

const created: string[] = [];

/**
 * Returns a directory under the temp root deep enough that `name` provably cannot fit beside it.
 *
 * How deep that is depends on the machine and its temporary-directory layout. Nesting until the limit is actually
 * exceeded keeps these tests about the fallback rather than about one machine's temp path.
 */
function tooDeepDirectory(name: string): string {
    let directory = join(tmpdir(), 'caxri-e2e-parallel-safe-0');
    while (isWithinUnixSocketLimit(join(directory, name))) directory = join(directory, 'nested');
    return directory;
}

afterEach(async () => {
    const paths = [...created];
    created.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true })));
});

describe('unixSocketPath', () => {
    it('keeps a socket in the preferred directory when it fits', () => {
        const socketPath = unixSocketPath(tmpdir(), 'caxri-fits.sock');
        expect(socketPath).toBe(join(tmpdir(), 'caxri-fits.sock'));
    });

    /**
     * The E2E harness gives every Playwright worker its own `caxri-e2e-<pool>-<index>` directory under the per-user
     * temp root, which is the shape that pushed both private sockets past `sun_path`.
     */
    it('falls back to the short private root when the preferred directory is too deep', () => {
        const name = 'caxri-hooks-0123456789abcdef-12345.sock';
        const workerDirectory = tooDeepDirectory(name);

        // Proves the fallback is what keeps this under the limit rather than the name happening to be short.
        expect(isWithinUnixSocketLimit(join(workerDirectory, name))).toBe(false);

        const socketPath = unixSocketPath(workerDirectory, name);
        expect(socketPath).toBe(join('/tmp', `caxri-${userInfo().uid}`, name));
        expect(isWithinUnixSocketLimit(socketPath)).toBe(true);
    });

    it('keeps every supported directory depth within the limit', () => {
        for (const depth of [0, 1, 2, 4, 8, 16]) {
            const directory = join(tmpdir(), ...Array.from({ length: depth }, () => 'nested-name'));
            const socketPath = unixSocketPath(directory, 'caxri-a-0123456789abcdef0123.sock');
            expect(Buffer.byteLength(socketPath, 'utf8')).toBeLessThanOrEqual(
                MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES,
            );
        }
    });

    it('rejects a relative directory', () => {
        expect(() => unixSocketPath('relative', 'caxri-a.sock')).toThrow('must be absolute');
    });

    it('rejects a name that cannot fit even in the short private root', () => {
        expect(() => unixSocketPath(tmpdir(), `${'n'.repeat(120)}.sock`)).toThrow(
            'exceeds the portable limit',
        );
    });

    it('measures the limit in bytes rather than characters', () => {
        const asciiName = `${'n'.repeat(MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES - 1)}`;
        expect(isWithinUnixSocketLimit(`/${asciiName}`)).toBe(true);
        // Each `é` is two UTF-8 bytes, so the same character count no longer fits.
        expect(
            isWithinUnixSocketLimit(`/${'é'.repeat(MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES - 1)}`),
        ).toBe(false);
    });
});

describe('ensureUnixSocketDirectory', () => {
    it('creates a private directory that can then be bound', async () => {
        const name = `caxri-hooks-${process.pid}-bind.sock`;
        const socketPath = unixSocketPath(tooDeepDirectory(name), name);
        created.push(socketPath);

        await ensureUnixSocketDirectory(socketPath);
        expect((await stat(dirname(socketPath))).mode & 0o777).toBe(0o700);

        const server = createServer();
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(socketPath, resolve);
            });
            expect((await stat(socketPath)).isSocket()).toBe(true);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('repairs an existing current-user fallback directory to mode 0700', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-socket-mode-'));
        try {
            await chmod(directory, 0o777);
            await ensurePrivateUnixSocketDirectory(directory);
            expect((await lstat(directory)).mode & 0o777).toBe(0o700);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('rejects a symlink used as a private fallback directory', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-socket-link-'));
        const target = join(temporary, 'target');
        const link = join(temporary, 'link');
        await mkdir(target);
        await symlink(target, link);
        try {
            await expect(ensurePrivateUnixSocketDirectory(link)).rejects.toThrow('real directory');
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    });

    it('rejects a private fallback directory owned by another uid', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-socket-owner-'));
        try {
            const metadata = await lstat(directory);
            expect(() => assertPrivateUnixSocketDirectory(metadata, userInfo().uid + 1)).toThrow(
                'owned by the current user',
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
