import type { Dirent } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '../../../../scripts/exec';
import { inspectDesktopLease } from './desktop-lease';
import { CommandError, isProcessIdentityAlive } from './process';
import {
    errorCode,
    isPathPresent,
    isWorktreeIdentity,
    registeredWorktreeIdentities,
    repoContext,
    unlinkIfExists,
    withRepoLock,
} from './repo';
import type { DevelopmentProcessRecord } from './worktree-development-process';
import { developmentProcessPath, readDevelopmentProcess } from './worktree-development-process';
import { PRESERVED_PROFILE_MARKER } from './worktree-profile-removal';

interface PruneProfileOperations {
    inspectPathOwner(path: string): Promise<number | undefined>;
}

export interface PruneProfilesResult {
    applied: boolean;
    failed: Array<{ path: string; reason: string }>;
    orphaned: string[];
    profileRoot: string;
    removed: string[];
    skipped: Array<{ path: string; reason: string }>;
}

async function inspectPathOwner(path: string): Promise<number | undefined> {
    try {
        const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-F', 'p', '--', path]);
        const pids = new Set(
            stdout
                .split(/\r?\n/u)
                .filter((line) => /^p\d+$/u.test(line))
                .map((line) => Number(line.slice(1))),
        );
        if (pids.size > 1) throw new Error(`Multiple processes own Caxri path: ${path}`);
        return [...pids][0];
    } catch (error) {
        if (String(errorCode(error)) === '1') return;
        throw error;
    }
}

const defaultOperations: PruneProfileOperations = { inspectPathOwner };

async function readProfileEntries(profileRoot: string): Promise<Dirent[]> {
    try {
        const metadata = await lstat(profileRoot);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new CommandError(`Refusing unsafe isolated profile root: ${profileRoot}`);
        }
        return await readdir(profileRoot, { withFileTypes: true });
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return [];
        throw error;
    }
}

export async function pruneOrphanProfiles(
    cwd: string,
    shouldApply: boolean,
    operationOverrides?: Partial<PruneProfileOperations>,
): Promise<PruneProfilesResult> {
    const context = await repoContext(cwd);
    const operations = { ...defaultOperations, ...operationOverrides };
    return withRepoLock(context, async () => {
        const profileRoot = join(context.stateDir, 'profiles');
        const entries = await readProfileEntries(profileRoot);
        /**
         * Profiles are listed before identities because first-time dev setup writes the identity before creating the
         * profile. Reading in this order makes either the identity or the profile visible to this locked snapshot.
         */
        const registeredIdentities = await registeredWorktreeIdentities(context);
        const desktop = await inspectDesktopLease(context.root);
        const candidates: Array<{ identity: string; path: string; staleProcess: boolean }> = [];
        const failed: PruneProfilesResult['failed'] = [];
        const skipped: PruneProfilesResult['skipped'] = [];

        for (const entry of entries) {
            const profile = join(profileRoot, entry.name);
            if (registeredIdentities.has(entry.name)) continue;
            if (!isWorktreeIdentity(entry.name)) {
                skipped.push({ path: profile, reason: 'unrecognized profile identity' });
                continue;
            }
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                skipped.push({ path: profile, reason: 'profile is not a real directory' });
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- each marker protects only its own profile
            if (await isPathPresent(join(profile, PRESERVED_PROFILE_MARKER))) {
                skipped.push({ path: profile, reason: 'profile was explicitly preserved' });
                continue;
            }
            let processRecord: DevelopmentProcessRecord | undefined;
            try {
                // eslint-disable-next-line no-await-in-loop -- each record protects only its own profile
                processRecord = await readDevelopmentProcess(context, entry.name);
            } catch {
                skipped.push({ path: profile, reason: 'invalid dev process record' });
                continue;
            }
            if (
                processRecord &&
                // eslint-disable-next-line no-await-in-loop -- liveness is checked against each durable record
                (await isProcessIdentityAlive(processRecord.pid, processRecord.identity))
            ) {
                skipped.push({ path: profile, reason: `active dev PID ${processRecord.pid}` });
                continue;
            }
            if (desktop.state === 'active' && desktop.lease.worktreeId === entry.name) {
                skipped.push({
                    path: profile,
                    reason: `active desktop lease ${desktop.lease.label}`,
                });
                continue;
            }
            const hostLock = join(profile, 'host', 'owner.lock');
            try {
                // eslint-disable-next-line no-await-in-loop -- each lock protects only its own profile
                const lock = await lstat(hostLock);
                if (
                    !lock.isFile() ||
                    lock.isSymbolicLink() ||
                    (typeof process.getuid === 'function' && lock.uid !== process.getuid())
                ) {
                    skipped.push({ path: profile, reason: 'unsafe Host lock' });
                    continue;
                }
                // eslint-disable-next-line no-await-in-loop -- each lock protects only its own profile
                const hostPid = await operations.inspectPathOwner(hostLock);
                if (hostPid) {
                    skipped.push({ path: profile, reason: `active Host PID ${hostPid}` });
                    continue;
                }
            } catch (error) {
                if (errorCode(error) !== 'ENOENT') {
                    skipped.push({ path: profile, reason: 'Host liveness check failed' });
                    continue;
                }
            }
            candidates.push({
                identity: entry.name,
                path: profile,
                staleProcess: Boolean(processRecord),
            });
        }

        const removed: string[] = [];
        if (shouldApply) {
            const concurrency = 8;
            for (let index = 0; index < candidates.length; index += concurrency) {
                const batch = candidates.slice(index, index + concurrency);
                // eslint-disable-next-line no-await-in-loop -- bounded batches avoid saturating the filesystem
                const results = await Promise.allSettled(
                    batch.map(async (candidate) => {
                        await rm(candidate.path, { force: true, recursive: true });
                        if (candidate.staleProcess)
                            await unlinkIfExists(
                                developmentProcessPath(context, candidate.identity),
                            );
                        return candidate.path;
                    }),
                );
                results.forEach((result, resultIndex) => {
                    if (result.status === 'fulfilled') removed.push(result.value);
                    else
                        failed.push({
                            path: batch[resultIndex].path,
                            reason: 'profile removal failed',
                        });
                });
            }
        }

        return {
            applied: shouldApply,
            failed: failed.toSorted((left, right) => left.path.localeCompare(right.path)),
            orphaned: candidates
                .map((candidate) => candidate.path)
                .toSorted((left, right) => left.localeCompare(right)),
            profileRoot,
            removed: removed.toSorted((left, right) => left.localeCompare(right)),
            skipped: skipped.toSorted((left, right) => left.path.localeCompare(right.path)),
        };
    });
}
