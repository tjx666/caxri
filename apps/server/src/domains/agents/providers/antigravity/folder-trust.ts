import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { readBoundedRegularFileText } from '@caxri/system';

import { atomicWriteUserConfig } from '../../../atomic-file';
import type { AgentEnvironment } from '../../contract';
import { antigravityStateDirectory } from './paths';

/**
 * Closed outcome of one trust grant. Only `granted` and `already_trusted` mean `agy` starts without its "trust this
 * folder" prompt; `skipped` (no settings file yet, or one whose shape this writer does not recognize) and `failed`
 * leave the prompt in place for the user to answer.
 */
export type AntigravityFolderTrustOutcome = 'already_trusted' | 'failed' | 'granted' | 'skipped';

/**
 * The settings file is a few hundred bytes; the bound only keeps a corrupt file from being read whole.
 */
const MAX_ANTIGRAVITY_SETTINGS_BYTES = 1024 * 1024;

export function antigravitySettingsPath(environment: AgentEnvironment): string {
    return join(antigravityStateDirectory(environment), 'settings.json');
}

/**
 * Adds a folder to `agy`'s `trustedWorkspaces`, the list its "Do you trust this folder?" prompt appends to. A delegated
 * Antigravity child always runs in a Terminal, and that prompt would hold it at startup until the user answered there.
 * Trusting a folder also lets `agy` load the workspace's own hooks, plugins, and skills, which is what answering the
 * prompt does too; the folder was already validated against a Project the user added.
 *
 * Nothing is created: a missing file means `agy` has not finished first-run setup, which owns it. Unknown keys and
 * their order are kept, and the file is read just before the atomic replace, so a concurrent `agy` write is lost only
 * in a window of a few milliseconds; `agy` has no lock to share.
 */
export async function grantAntigravityFolderTrust(
    environment: AgentEnvironment,
    folder: string,
): Promise<AntigravityFolderTrustOutcome> {
    const path = antigravitySettingsPath(environment);
    const [keys, current] = await Promise.all([trustKeys(folder), readSettings(path)]);
    if (!current) return 'skipped';
    const trusted = new Set(current.trustedWorkspaces);
    if (keys.some((key) => trusted.has(key))) return 'already_trusted';
    const next = {
        ...current.settings,
        trustedWorkspaces: [...current.trustedWorkspaces, ...keys],
    };
    try {
        // `agy` writes this file with two-space indentation and a final newline; matching it keeps the diff to one entry.
        await atomicWriteUserConfig(path, `${JSON.stringify(next, null, 2)}\n`);
    } catch {
        return 'failed';
    }
    return 'granted';
}

interface AntigravitySettings {
    settings: Record<string, unknown>;
    trustedWorkspaces: string[];
}

async function readSettings(path: string): Promise<AntigravitySettings | undefined> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(await readBoundedRegularFileText(path, MAX_ANTIGRAVITY_SETTINGS_BYTES));
    } catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const settings = parsed as Record<string, unknown>;
    const trusted = settings.trustedWorkspaces;
    if (trusted !== undefined && !isStringArray(trusted)) return undefined;
    return { settings, trustedWorkspaces: trusted ?? [] };
}

/**
 * The folder as given and its real path, so a workspace reached through a symlink is trusted under either spelling.
 */
async function trustKeys(folder: string): Promise<string[]> {
    try {
        const real = await realpath(folder);
        return real === folder ? [folder] : [real, folder];
    } catch {
        return [folder];
    }
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
