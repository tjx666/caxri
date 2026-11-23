import { randomUUID } from 'node:crypto';
import { lstat, rename, rm } from 'node:fs/promises';

import { CaxriError } from '@caxri/protocol';
import Database from 'better-sqlite3';

import type { AgentEnvironment } from '../../contract';
import { isOpaqueAgentSessionId } from '../../contract';
import { readAntigravityUserStepTexts } from './conversation-database';
import { antigravityConversationPath } from './paths';

/**
 * Where a copy ends: just before the user message that starts `userTexts`, the Chat's own user messages from that one
 * to the newest, oldest first.
 */
export interface AntigravityConversationCut {
    userTexts: readonly string[];
}

/**
 * A copy was written under a new conversation id, or the cut kept no user message at all, so nothing was copied and the
 * caller starts a new conversation instead.
 */
export type AntigravityConversationCopy =
    { kind: 'copied'; conversationId: string } | { kind: 'empty' };

/**
 * Compares the start of two prompts with whitespace collapsed, as Grok Build's rewind compares its preview: `agy` keeps
 * the prompt as it was sent, while the Chat may show it with attachments described differently.
 */
function isSameStart(recorded: string, shown: string): boolean {
    const start = (text: string) => text.replaceAll(/\s+/gu, ' ').trim().slice(0, 40);
    const left = start(recorded);
    const right = start(shown);
    const shorter = Math.min(left.length, right.length);
    return left.slice(0, shorter) === right.slice(0, shorter) && (shorter > 0 || left === right);
}

/**
 * The `steps.idx` the cut starts at: the newest user steps must be the Chat's user messages from the cut on, one for
 * one, or the record holds turns the Chat does not show (or the other way round) and cutting would drop the wrong
 * ones.
 */
function cutIndex(
    steps: ReadonlyArray<{ idx: number; text: string }>,
    cut: AntigravityConversationCut,
): number {
    const tail = steps.slice(steps.length - cut.userTexts.length);
    if (
        cut.userTexts.length === 0 ||
        tail.length !== cut.userTexts.length ||
        tail.some((step, index) => !isSameStart(step.text, cut.userTexts[index] ?? ''))
    )
        throw new CaxriError(
            'CONFLICT',
            "Antigravity's record of this conversation does not match the Chat, so it was left as it is",
        );
    return tail[0]?.idx ?? 0;
}

/**
 * Copies one `agy` conversation database (see `conversation-database.ts`) under a new conversation id, ending just
 * before `cut` when given, for "Edit from here" and "Fork from here": `agy acp` can neither truncate nor copy a
 * conversation itself. The source is never written: `VACUUM INTO` takes a consistent snapshot even while `agy` holds it
 * open, and the copy is cut and renamed into place only once it checks out.
 *
 * The copy drops every `gen_metadata` and `executor_metadata` row. They hold per-call usage and executor state, not
 * history (measured on `agy` 1.5.14: a copy without them resumed with exactly the kept turns), and kept rows would
 * count the original's usage a second time. `trajectory_meta` gets the new id, as `agy` gives each conversation.
 */
export async function copyAntigravityConversation(
    environment: AgentEnvironment,
    conversationId: string,
    cut: AntigravityConversationCut | undefined,
): Promise<AntigravityConversationCopy> {
    if (!isOpaqueAgentSessionId(conversationId))
        throw new CaxriError('VALIDATION', 'Not an Antigravity conversation id');
    const source = antigravityConversationPath(environment, conversationId);
    let isRecorded = false;
    try {
        isRecorded = (await lstat(source)).isFile();
    } catch {
        // A missing record is reported below.
    }
    if (!isRecorded)
        throw new CaxriError('NOT_FOUND', "Antigravity's record of this conversation is missing");
    const copyId = randomUUID();
    const target = antigravityConversationPath(environment, copyId);
    // Not a `<uuid>.db` name, so conversation discovery never reads a half-written copy.
    const partial = `${target}.partial`;
    try {
        const reader = new Database(source, { fileMustExist: true, readonly: true });
        try {
            reader.prepare('VACUUM INTO ?').run(partial);
        } finally {
            reader.close();
        }
        // Read from the snapshot, so the check and the cut see the same steps.
        let start: number | undefined;
        if (cut) {
            const steps = readAntigravityUserStepTexts(partial);
            if (!steps)
                throw new CaxriError(
                    'UNAVAILABLE',
                    "Antigravity's record of this conversation is unreadable",
                );
            start = cutIndex(steps, cut);
            if (steps[0]?.idx === start) {
                await rm(partial, { force: true });
                return { kind: 'empty' };
            }
        }
        const copy = new Database(partial, { fileMustExist: true });
        try {
            copy.transaction(() => {
                if (start !== undefined)
                    copy.prepare('DELETE FROM steps WHERE idx >= ?').run(start);
                copy.exec('DELETE FROM gen_metadata; DELETE FROM executor_metadata;');
                copy.prepare('UPDATE trajectory_meta SET trajectory_id = ?, cascade_id = ?').run(
                    randomUUID(),
                    copyId,
                );
            })();
        } finally {
            copy.close();
        }
        await rename(partial, target);
    } catch (error) {
        await rm(partial, { force: true });
        if (error instanceof CaxriError) throw error;
        throw new CaxriError('UNAVAILABLE', 'Antigravity could not copy this conversation');
    }
    return { kind: 'copied', conversationId: copyId };
}
