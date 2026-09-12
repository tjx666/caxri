import { Buffer } from 'node:buffer';
import { rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import {
    ensureUnixSocketDirectory,
    isWithinUnixSocketLimit,
    MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES,
    unixSocketPath,
} from '../unix-socket-path';

const created: string[] = [];

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
        const workerDirectory = join(tmpdir(), 'caxri-e2e-parallel-safe-0');
        const name = 'caxri-hooks-0123456789abcdef-12345.sock';

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
        const socketPath = unixSocketPath(
            join(tmpdir(), 'caxri-e2e-parallel-safe-0'),
            `caxri-hooks-${process.pid}-bind.sock`,
        );
        created.push(socketPath);

        await ensureUnixSocketDirectory(socketPath);
        expect((await stat(dirname(socketPath))).mode & 0o700).toBe(0o700);

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
});
