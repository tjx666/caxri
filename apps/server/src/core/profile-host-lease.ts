import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

import { CaxriError, isCaxriError } from '@caxri/protocol';
import { z } from 'zod';

import { fileSystemCode, readPrivateJsonFile, replacePrivateJsonFile } from './private-json-store';

/**
 * How often the owning Server rewrites its lease, and how long another host must see it unchanged before taking over.
 * The gap tolerates a few missed renewals plus ordinary NTP-level clock differences between the hosts.
 */
const HOST_LEASE_RENEW_INTERVAL_MS = 15_000;
export const HOST_LEASE_TTL_MS = 60_000;

const hostLeaseSchema = z.strictObject({
    hostId: z.string().min(1).max(1024),
    hostname: z.string().min(1).max(255),
    processIdentity: z.string().min(1).max(128),
    renewedAt: z.number().int().nonnegative(),
});
type HostLeaseRecord = z.infer<typeof hostLeaseSchema>;

export interface HostIdentity {
    /**
     * Distinguishes hosts that share one home directory. The hostname alone tells cluster login nodes apart; the
     * machine id is added because two containers cloned from one image share it but not their hostname, and two real
     * machines may reuse a short hostname.
     */
    hostId: string;
    hostname: string;
}

export async function readHostIdentity(): Promise<HostIdentity> {
    const name = hostname();
    let machineId = '';
    try {
        machineId = (await readFile('/etc/machine-id', 'utf8')).trim();
    } catch {
        // Minimal containers ship without a machine id; the hostname still separates them.
    }
    return { hostId: `${name}/${machineId}`, hostname: name };
}

export interface HostLease {
    release(): Promise<void>;
}

async function readLease(path: string): Promise<HostLeaseRecord | undefined> {
    let value: unknown;
    try {
        value = await readPrivateJsonFile({
            path,
            maxBytes: 4096,
            messages: {
                malformed: 'Host lease is malformed',
                notPrivate: 'Host lease is not private',
                oversized: 'Host lease is oversized',
                wrongOwner: 'Host lease belongs to another user',
            },
        });
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT') return;
        // Only this user's Servers write the lease and every write is an atomic rename, so an unreadable record is
        // not a live owner's: treat it as absent and overwrite it.
        if (isCaxriError(error) && error.code === 'VALIDATION') return;
        throw error;
    }
    const parsed = hostLeaseSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

function profileInUse(holder: HostLeaseRecord): CaxriError {
    return new CaxriError('CONFLICT', `The profile is in use by a Server on ${holder.hostname}`, {
        reason: 'profileInUse',
        hostname: holder.hostname,
    });
}

/**
 * Keeps two hosts that share one home directory (NFS cluster login nodes, for example) from running Servers on the same
 * profile. The kernel lock in `linux-profile-lock.ts` and the pid probe in `profile.ts` only see the local machine, so
 * without this a second host would treat the first host's live Server as dead, delete its manifest, and open the same
 * SQLite database.
 *
 * The owner rewrites the lease every {@link HOST_LEASE_RENEW_INTERVAL_MS}. Another host refuses to start while the lease
 * is younger than {@link HOST_LEASE_TTL_MS} and takes it over once it is older, which covers a crashed owner. A lease
 * from this same host is always taken over: the kernel lock already proved its writer is gone.
 *
 * Two hosts claiming an empty lease in the same instant can both pass the read; each renewal therefore re-reads the
 * lease, and the Server that finds another identity there calls `onLost` and stops instead of writing on.
 */
export async function claimHostLease(options: {
    directory: string;
    identity: HostIdentity;
    now?: () => number;
    onLost: (holder: string) => void;
    path: string;
    processIdentity: string;
    renewIntervalMs?: number;
    ttlMs?: number;
}): Promise<HostLease> {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? HOST_LEASE_TTL_MS;
    const write = () =>
        replacePrivateJsonFile({
            directory: options.directory,
            path: options.path,
            temporaryPrefix: '.host-lease-',
            value: {
                hostId: options.identity.hostId,
                hostname: options.identity.hostname,
                processIdentity: options.processIdentity,
                renewedAt: now(),
            } satisfies HostLeaseRecord,
        });
    const isMine = (record: HostLeaseRecord | undefined) =>
        record?.processIdentity === options.processIdentity;

    const current = await readLease(options.path);
    if (current && current.hostId !== options.identity.hostId && now() - current.renewedAt < ttlMs)
        throw profileInUse(current);
    await write();

    let isReleased = false;
    let renewal: Promise<void> | undefined;
    const renew = async () => {
        try {
            const record = await readLease(options.path);
            if (isReleased) return;
            if (record && !isMine(record)) {
                // The next tick sees `isReleased` and stops the timer.
                isReleased = true;
                options.onLost(record.hostname);
                return;
            }
            await write();
        } catch {
            // A transient NFS error skips one renewal; the TTL spans several intervals.
        } finally {
            renewal = undefined;
        }
    };
    const timer = setInterval(() => {
        if (isReleased) {
            clearInterval(timer);
            return;
        }
        renewal ??= renew();
    }, options.renewIntervalMs ?? HOST_LEASE_RENEW_INTERVAL_MS);
    // The lease must not keep the event loop alive past the Server's own shutdown.
    timer.unref();

    return {
        async release() {
            if (isReleased) return;
            isReleased = true;
            clearInterval(timer);
            await renewal;
            try {
                if (isMine(await readLease(options.path)))
                    await replacePrivateJsonFile({
                        directory: options.directory,
                        path: options.path,
                        temporaryPrefix: '.host-lease-',
                        value: {},
                    });
            } catch {
                // Best effort: an unremoved lease only delays another host by one TTL.
            }
        },
    };
}
