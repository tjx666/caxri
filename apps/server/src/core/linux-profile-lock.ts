import { constants as fileConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import process from 'node:process';

import { CaxriError } from '@caxri/protocol';

import { fileSystemCode } from './private-json-store';

export type LockHandle = Awaited<ReturnType<typeof open>>;

/**
 * An exclusive profile lock: the open lock file carrying owner metadata, plus whatever kernel object enforces
 * exclusivity on this platform.
 */
export interface ProcessLock {
    handle: LockHandle;
    close: () => Promise<void>;
}

/**
 * Linux has no open-time lock flag and Node exposes no `flock`, so exclusivity comes from binding an abstract-namespace
 * Unix socket named after the profile. The kernel owns the name: a second bind fails with EADDRINUSE, and the name
 * disappears the instant the owner exits, including on SIGKILL, so a crashed Host never leaves a stale lock behind. The
 * name carries the uid so another account on a shared machine cannot collide with this one by accident.
 */
export async function acquireLinuxProcessLock(
    path: string,
    profileId: string,
): Promise<ProcessLock> {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const server = await bindAbstractSocket(`\0caxri-profile-${uid}-${profileId}`);
    try {
        const handle = await open(
            path,
            fileConstants.O_RDWR | fileConstants.O_CREAT | fileConstants.O_NOFOLLOW,
            0o600,
        );
        return {
            handle,
            close: async () => {
                try {
                    await handle.close();
                } finally {
                    await closeServer(server);
                }
            },
        };
    } catch (error) {
        await closeServer(server);
        throw error;
    }
}

function bindAbstractSocket(name: string): Promise<Server> {
    return new Promise((resolve, reject) => {
        // Nothing legitimate connects to the lock socket; drop any connection immediately.
        const server = createServer((socket) => socket.destroy());
        server.once('error', (error) => {
            reject(
                fileSystemCode(error) === 'EADDRINUSE'
                    ? new CaxriError('CONFLICT', 'A Host already owns this profile')
                    : error,
            );
        });
        server.listen({ path: name, exclusive: true }, () => {
            // The lock must not hold the event loop open past the Host's own shutdown.
            server.unref();
            resolve(server);
        });
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}
