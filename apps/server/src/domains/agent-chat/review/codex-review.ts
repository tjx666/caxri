import type { AgentChatItem } from '@caxri/protocol';
import { CaxriError, MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { clip } from '../chat-items';
import type { JsonRpcConnection } from '../json-rpc-connection';

/**
 * Codex `ReviewTarget` for `review/start`, from `codex app-server generate-ts`. `commit.title` is a required key whose
 * value may be null.
 */
export type CodexReviewTarget =
    | { type: 'uncommittedChanges' }
    | { type: 'baseBranch'; branch: string }
    | { type: 'commit'; sha: string; title: null }
    | { type: 'custom'; instructions: string };

const REVIEW_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Reads the arguments of `/review`: none reviews the uncommitted changes, `--base <branch>` compares against a base
 * branch, `--commit <sha>` reviews one commit, and any other text is custom review instructions. Whether the branch or
 * commit exists is Codex's to say, so its error reaches the user as the command's failure.
 */
export function parseCodexReviewArguments(arguments_: string | undefined): CodexReviewTarget {
    const trimmed = arguments_?.trim();
    if (!trimmed) return { type: 'uncommittedChanges' };
    const flag = /^--(base|commit)(?=\s|$)/u.exec(trimmed);
    if (!flag) return { type: 'custom', instructions: trimmed };
    const value = trimmed.slice(flag[0].length).trim();
    if (!value)
        throw new CaxriError(
            'VALIDATION',
            flag[1] === 'base'
                ? 'Name the base branch after --base'
                : 'Name the commit after --commit',
        );
    if (/\s/u.test(value))
        throw new CaxriError(
            'VALIDATION',
            `--${flag[1]} takes a single ${flag[1] === 'base' ? 'branch name' : 'commit SHA'}`,
        );
    return flag[1] === 'base'
        ? { type: 'baseBranch', branch: value }
        : { type: 'commit', sha: value, title: null };
}

/**
 * Starts Codex's review inline on the thread. Codex reports it as a turn, so the usual turn and review item events
 * drive the Chat, as they do for `/compact`.
 */
export async function startCodexReview(
    connection: JsonRpcConnection,
    threadId: string | undefined,
    arguments_: string | undefined,
): Promise<void> {
    const target = parseCodexReviewArguments(arguments_);
    await connection.request(
        'review/start',
        { threadId, target, delivery: 'inline' },
        REVIEW_REQUEST_TIMEOUT_MS,
    );
}

/**
 * Maps the `enteredReviewMode` and `exitedReviewMode` items. Entering is a short notice naming what Codex reviews (its
 * `review` field is the target's user-facing hint); leaving carries the review's conclusion as Markdown, which Codex
 * does not repeat as an agent message, so it is shown as one.
 */
export function mapCodexReviewItem(
    raw: Record<string, unknown>,
    base: { id: string; turnId?: string },
): AgentChatItem | undefined {
    const review = typeof raw.review === 'string' ? raw.review.trim() : '';
    if (raw.type === 'enteredReviewMode')
        return {
            ...base,
            type: 'notice',
            kind: 'output',
            message: clip(review ? `Reviewing ${review}` : 'Review started', 2_000),
        };
    if (raw.type === 'exitedReviewMode')
        return review
            ? {
                  ...base,
                  type: 'agentMessage',
                  text: clip(review, MAX_AGENT_CHAT_TEXT_LENGTH),
                  streaming: false,
              }
            : undefined;
    return undefined;
}
