import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { readBoundedRegularFileText } from '@caxri/system';

import { atomicWriteUserConfig } from '../../../atomic-file';
import type { AgentEnvironment } from '../../contract';
import { MAX_CLAUDE_GLOBAL_CONFIG_BYTES, resolveClaudeGlobalConfigPath } from './paths';

/**
 * Closed outcome of one trust grant. Only `granted` and `already_trusted` mean Claude Code will start without its
 * workspace trust dialog; every other value leaves the dialog in place for the user to answer.
 */
export type ClaudeFolderTrustOutcome =
    'already_trusted' | 'granted' | 'locked' | 'missing_config' | 'unreadable' | 'write_failed';

export interface ClaudeFolderTrustOptions {
    /**
     * Attempts to take Claude Code's config lock before giving up with `locked`. A running Claude Code holds it only
     * for the few milliseconds one config write takes.
     */
    lockAttempts?: number;
    lockRetryDelayMs?: number;
}

const DEFAULT_LOCK_ATTEMPTS = 20;
const DEFAULT_LOCK_RETRY_DELAY_MS = 50;

/**
 * Marks folders as trusted in Claude Code's global config, the same record its "Do you trust the files in this folder?"
 * dialog writes. Claude Code shows that dialog even under `--dangerously-skip-permissions`, and a Caxri-owned workspace
 * such as Caxri Bot's would otherwise stall on it at every first launch.
 *
 * Claude Code serializes its own config writes with a `proper-lockfile` directory lock at `<config>.lock` and re-reads
 * the file under that lock, so this writer takes the same lock, re-reads, and replaces the file atomically. A held lock
 * is never broken: after the bounded retries the grant gives up with `locked` and the dialog appears as usual. A
 * missing config means Claude Code has not finished first-run setup, which owns that file, so nothing is created.
 */
export async function grantClaudeFolderTrust(
    environment: AgentEnvironment,
    folders: readonly string[],
    options: ClaudeFolderTrustOptions = {},
): Promise<ClaudeFolderTrustOutcome> {
    const configPath = await resolveClaudeGlobalConfigPath(environment);
    let target: string;
    try {
        target = await realpath(configPath);
    } catch (error) {
        return isMissing(error) ? 'missing_config' : 'unreadable';
    }
    const keys = await trustKeys(folders);
    /**
     * Claude Code names its lock after the config path as it looked it up, not after a link's target, so a config
     * linked from a dotfiles folder is still locked beside the link. The write itself goes through the target so the
     * link survives.
     */
    const lockPath = `${configPath}.lock`;
    if (!(await didAcquireLock(lockPath, options))) return 'locked';
    try {
        let config: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(
                await readBoundedRegularFileText(target, MAX_CLAUDE_GLOBAL_CONFIG_BYTES),
            );
            if (!isRecord(parsed)) return 'unreadable';
            config = parsed;
        } catch {
            return 'unreadable';
        }
        const projects = isRecord(config.projects) ? config.projects : {};
        const untrusted = keys.filter((key) => {
            const project = projects[key];
            return !isRecord(project) || project.hasTrustDialogAccepted !== true;
        });
        if (untrusted.length === 0) return 'already_trusted';
        for (const key of untrusted) {
            const project = projects[key];
            projects[key] = { ...(isRecord(project) && project), hasTrustDialogAccepted: true };
        }
        config.projects = projects;
        try {
            // Claude Code writes this file with two-space indentation; matching it keeps the user's diff to one key.
            await atomicWriteUserConfig(target, `${JSON.stringify(config, null, 2)}\n`);
        } catch {
            return 'write_failed';
        }
        return 'granted';
    } finally {
        await releaseLock(lockPath);
    }
}

/**
 * Claude Code keys `projects` by the NFC-normalized absolute path it was started in. The real path is trusted too, so a
 * workspace reached through a symlinked profile directory needs no second dialog.
 */
async function trustKeys(folders: readonly string[]): Promise<string[]> {
    const resolved = await Promise.all(
        folders.map(async (folder) =>
            [folder, await canonicalPath(folder)].map((path) => path.normalize('NFC')),
        ),
    );
    return [...new Set(resolved.flat())];
}

async function canonicalPath(folder: string): Promise<string> {
    try {
        return await realpath(folder);
    } catch {
        return folder;
    }
}

async function didAcquireLock(
    lockPath: string,
    options: ClaudeFolderTrustOptions,
): Promise<boolean> {
    const attempts = options.lockAttempts ?? DEFAULT_LOCK_ATTEMPTS;
    const retryDelay = options.lockRetryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            // Each attempt waits for the previous holder, so the retries are sequential by design.
            // eslint-disable-next-line no-await-in-loop -- bounded lock retry, see comment above
            await mkdir(lockPath);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
            // eslint-disable-next-line no-await-in-loop -- bounded lock retry, see comment above
            if (attempt + 1 < attempts) await delay(retryDelay);
        }
    }
    return false;
}

/**
 * Best effort: a lock left behind only delays Claude Code's next write until its own stale-lock timeout.
 */
async function releaseLock(lockPath: string): Promise<void> {
    try {
        await rmdir(lockPath);
    } catch {
        // See JSDoc above.
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
