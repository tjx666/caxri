import { basename } from 'node:path';

import Database from 'better-sqlite3';

import { COMPRESSED_TRANSCRIPT_SUFFIX } from '../../transcript-compression';
import type { SqliteColumn } from './state-databases';
import { findCodexStateDatabases } from './state-databases';

const UUID_V7 = String.raw`[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[\da-f]{4}-[\da-f]{12}`;
const ROLLOUT_ID = String.raw`[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}`;

/**
 * Canonical Codex rollout basename. An ordinary thread writes `rollout-<wall clock>-<thread id>.jsonl`, where the one
 * ID is both the thread ID and the rollout ID. Reverting a thread (editing an earlier prompt with Esc Esc) writes a new
 * immutable rollout named `rollout-<wall clock>-<thread id>_<rollout id>.jsonl`; the thread ID stays stable while the
 * turns written after the revert belong to the new rollout ID.
 *
 * @see https://github.com/openai/codex/blob/d8f69ea/codex-rs/rollout/src/rollout_file_name.rs
 */
export const CODEX_ROLLOUT_NAME_PATTERN = new RegExp(
    String.raw`^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(${UUID_V7})(?:_(${ROLLOUT_ID}))?\.jsonl$`,
    'i',
);

export interface CodexRolloutName {
    threadId: string;
    /**
     * Equals {@link threadId} for an ordinary, never-reverted rollout.
     */
    rolloutId: string;
}

export function parseCodexRolloutName(name: string): CodexRolloutName | undefined {
    const match = CODEX_ROLLOUT_NAME_PATTERN.exec(name);
    const threadId = match?.[1];
    if (!threadId) return;
    // `at` keeps the absent optional capture of an ordinary rollout typed as possibly undefined.
    return { threadId, rolloutId: match.at(2) ?? threadId };
}

export interface CodexRolloutFile extends CodexRolloutName {
    /**
     * The rollout is stored as `<canonical name>.zst`; see `transcript-compression.ts`.
     */
    isCompressed: boolean;
}

/**
 * Parses a rollout file name in either storage form: the canonical `.jsonl` or the `.jsonl.zst` Codex compresses a cold
 * rollout into. {@link CODEX_ROLLOUT_NAME_PATTERN} stays canonical-only for the readers that need an appendable file.
 */
export function parseCodexRolloutFile(name: string): CodexRolloutFile | undefined {
    const isCompressed = name.toLowerCase().endsWith(COMPRESSED_TRANSCRIPT_SUFFIX);
    const rollout = parseCodexRolloutName(
        isCompressed ? name.slice(0, -COMPRESSED_TRANSCRIPT_SUFFIX.length) : name,
    );
    return rollout && { ...rollout, isCompressed };
}

/**
 * The rollout ID that currently carries a Codex thread's new turns. Codex projects `thread_turns` per rollout, so after
 * a revert the running turn is keyed by the new rollout ID rather than the thread ID; `threads.rollout_path` is the
 * single mutable pointer Codex moves to that rollout. Returns `undefined` for a never-reverted thread and whenever the
 * private schema or path cannot prove a distinct rollout, so callers keep querying by thread ID alone.
 *
 * @see https://github.com/openai/codex/blob/d8f69ea/codex-rs/thread-store/src/local/revert_thread.rs
 */
export async function readCodexCurrentRolloutId(
    threadId: string,
    stateDirectories: string[],
): Promise<string | undefined> {
    const databasePaths = await findCodexStateDatabases(stateDirectories);
    for (const path of databasePaths) {
        let database: Database.Database | undefined;
        try {
            database = new Database(path, { fileMustExist: true, readonly: true });
            const columns = new Set(
                (database.prepare('PRAGMA table_info(threads)').all() as SqliteColumn[]).map(
                    (column) => column.name,
                ),
            );
            if (!columns.has('id') || !columns.has('rollout_path')) continue;
            const row = database
                .prepare('SELECT rollout_path FROM threads WHERE id = ? LIMIT 1')
                .get(threadId) as { rollout_path: unknown } | undefined;
            if (!row) continue;
            if (typeof row.rollout_path !== 'string') return;
            const rollout = parseCodexRolloutFile(basename(row.rollout_path));
            if (rollout?.threadId.toLowerCase() !== threadId.toLowerCase()) return;
            return rollout.rolloutId.toLowerCase() === threadId.toLowerCase()
                ? undefined
                : rollout.rolloutId;
        } catch {
            // Codex owns this private schema; drift degrades to the thread-ID-only query.
        } finally {
            database?.close();
        }
    }
    return undefined;
}
