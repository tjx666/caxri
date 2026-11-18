import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { readBoundedRegularFileText } from '@caxri/system';

import { atomicWriteUserConfig } from '../../../atomic-file';
import type { AgentEnvironment } from '../../contract';
import { grokHome } from './paths';

/**
 * Closed outcome of one trust grant. Only `granted` and `already_trusted` mean Grok Build starts without its "Do you
 * trust the contents of this directory?" prompt. `declined` is a folder the user already answered "No" for, which this
 * writer never overrides; `skipped` (no Grok home, an over-broad or unquotable folder, or a store whose layout this
 * writer does not recognize) and `failed` leave the prompt in place for the user to answer.
 */
export type GrokFolderTrustOutcome =
    'already_trusted' | 'declined' | 'failed' | 'granted' | 'skipped';

/**
 * The store holds one short table per folder ever answered; the bound only keeps a corrupt file from being read whole.
 */
const MAX_GROK_TRUST_STORE_BYTES = 1024 * 1024;

export function grokTrustStorePath(environment: AgentEnvironment): string {
    return join(grokHome(environment), 'trusted_folders.toml');
}

/**
 * Records a folder as trusted in Grok Build's `trusted_folders.toml`, the store its startup trust prompt writes. A
 * dispatched Grok child always runs in a Terminal, and that prompt would hold it at startup until the user answered
 * there. Grok keys the record on the folder's canonical path and never inherits a grant across Git repositories, so
 * every new linked worktree asks again even when its main checkout is trusted; answering once per Project root cannot
 * help. The folder was already validated against a Project the user added.
 *
 * The store is TOML (`[folders."<canonical path>"]` with `trusted` and `decided_at`). This writer appends one table and
 * leaves every existing byte in place rather than re-serializing a document it does not own. A duplicate table would
 * make the whole store unreadable, and Grok then refuses to start, so any appearance of the key other than the exact
 * table header Grok writes ends in `skipped`. Grok serializes its own writers with an `flock` on
 * `trusted_folders.toml.lock` that Node cannot take; the file is read just before the atomic replace, so a concurrent
 * Grok write is lost only within a window of a few milliseconds, and Grok then asks again.
 *
 * @see https://github.com/xai-org/grok-build/blob/2bdd1d6/crates/codegen/xai-grok-permission-rules/src/trust.rs
 */
export async function grantGrokFolderTrust(
    environment: AgentEnvironment,
    folder: string,
    now: () => Date = () => new Date(),
): Promise<GrokFolderTrustOutcome> {
    const home = grokHome(environment);
    if (!(await isDirectory(home))) return 'skipped';
    const key = await canonical(folder);
    if (!isRecordableKey(key) || key === (await canonical(environment.homeDirectory)))
        return 'skipped';
    const path = grokTrustStorePath(environment);
    let text: string;
    try {
        text = await readStore(path);
    } catch {
        return 'failed';
    }
    const existing = existingDecision(text, key);
    if (existing === 'unrecognized') return 'skipped';
    if (existing === true) return 'already_trusted';
    if (existing === false) return 'declined';
    const decidedAt = Math.floor(now().getTime() / 1000);
    const separator = text.trim() === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    const prefix = text.trim() === '' ? '' : text;
    try {
        await atomicWriteUserConfig(
            path,
            `${prefix}${separator}${tableHeader(key)}\ntrusted = true\ndecided_at = ${decidedAt}\n`,
        );
    } catch {
        return 'failed';
    }
    return 'granted';
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

async function canonical(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return path;
    }
}

/**
 * Grok refuses to record the filesystem root or a relative path. A key that would need TOML escaping is skipped too,
 * since this writer only recognizes the plain quoted header Grok writes for an ordinary path.
 */
function isRecordableKey(key: string): boolean {
    return (
        key.startsWith('/') &&
        key !== '/' &&
        [...key].every(
            (character) => !(character === '"' || character === '\\' || isControl(character)),
        )
    );
}

function isControl(character: string): boolean {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
}

function tableHeader(key: string): string {
    return `[folders."${key}"]`;
}

async function readStore(path: string): Promise<string> {
    try {
        return await readBoundedRegularFileText(path, MAX_GROK_TRUST_STORE_BYTES);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
    }
}

/**
 * The recorded decision for `key`: `true` or `false` from its exact table, `undefined` when the key never appears, and
 * `unrecognized` when it appears in any other shape (a literal-quoted header, a dotted key, an inline table, or a table
 * without a boolean `trusted`) that this line reader cannot safely interpret.
 */
function existingDecision(text: string, key: string): boolean | 'unrecognized' | undefined {
    const lines = text.split(/\r?\n/u);
    // Quoted, so a sibling such as `/repo-worktrees/x` never counts as a mention of `/repo`.
    const mentions = lines.filter((line) => line.includes(`"${key}"`) || line.includes(`'${key}'`));
    if (mentions.length === 0) return undefined;
    const header = tableHeader(key);
    const start = lines.findIndex((line) => line.trim() === header);
    if (start === -1 || mentions.length > 1) return 'unrecognized';
    const body = lines.slice(start + 1);
    for (const line of body) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) break;
        const match = /^trusted\s*=\s*(true|false)\s*(?:#.*)?$/u.exec(trimmed);
        if (match) return match[1] === 'true';
    }
    return 'unrecognized';
}
