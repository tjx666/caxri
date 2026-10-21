import { CaxriError } from '@caxri/protocol';

import { clip, isRecord, stringField } from '../chat-items';
import type { ChatForkTarget, ChatRewindTarget } from '../chat-provider';
import type { JsonRpcConnection } from '../json-rpc-connection';
import { JsonRpcRequestError } from '../json-rpc-connection';

const REWIND_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Whitespace-insensitive start of a prompt, for comparing Grok Build's preview with the Chat's copy of the message.
 */
function promptStart(text: string): string {
    return text.replaceAll(/\s+/gu, ' ').trim().slice(0, 40);
}

/**
 * The `prompt_index` `_x.ai/rewind/execute` takes for `target`, from an `_x.ai/rewind/points` result (`rewind_points`,
 * one per prompt). The Chat's turns are the session's newest prompts, one each, so the target is `removedTurns` points
 * from the end. `undefined` when the list is too short or the point's preview names a different message: rewinding the
 * wrong prompt would remove turns the user did not choose.
 */
export function grokRewindPoint(
    listed: unknown,
    target: Pick<ChatRewindTarget, 'removedTurns' | 'text'>,
): number | undefined {
    const points = (
        isRecord(listed) && Array.isArray(listed.rewind_points) ? listed.rewind_points : []
    )
        .filter(isRecord)
        .filter((point) => Number.isSafeInteger(point.prompt_index))
        .toSorted((left, right) => Number(left.prompt_index) - Number(right.prompt_index));
    const point = points.at(points.length - target.removedTurns);
    if (!point || target.removedTurns < 1) return undefined;
    // A missing or empty preview cannot confirm the point, and with `mode: all` a wrong one reverts the wrong files.
    if (typeof point.prompt_preview !== 'string') return undefined;
    const preview = promptStart(point.prompt_preview.replace(/(?:…|\.\.\.)$/u, ''));
    const message = promptStart(target.text);
    const shorter = Math.min(preview.length, message.length);
    if (shorter === 0 || preview.slice(0, shorter) !== message.slice(0, shorter)) return undefined;
    return Number(point.prompt_index);
}

/**
 * The index Grok Build gives the prompt that `target` starts, in the whole session, while the projection may hold only
 * the newest turns: it comes from `_x.ai/rewind/points` counted back from the newest prompt, and the point's preview
 * must agree with the message. An `_x.ai/interject` adds no point of its own (verified on Grok Build 1.0.62: one
 * interjection and two prompts list two points), so the Chat's turns map one to one onto points. `action` names the
 * user's action in the refusal.
 */
async function grokPromptIndex(
    connection: JsonRpcConnection,
    sessionId: string,
    target: ChatForkTarget,
    action: 'edit' | 'fork' | 'restore',
): Promise<number> {
    let listed: unknown;
    try {
        listed = await connection.request(
            '_x.ai/rewind/points',
            { sessionId },
            REWIND_REQUEST_TIMEOUT_MS,
        );
    } catch (error) {
        if (!(error instanceof JsonRpcRequestError)) throw error;
        throw new CaxriError(
            'UNAVAILABLE',
            `This Grok Build version cannot ${action === 'fork' ? 'fork' : 'rewind'} a conversation; update Grok Build`,
        );
    }
    const point = grokRewindPoint(listed, target);
    if (point === undefined)
        throw new CaxriError(
            'CONFLICT',
            "Grok Build's record does not match this Chat; restart the Chat and try again",
        );
    return point;
}

/**
 * Grok Build's `RewindMode`: `files_only` restores the per-prompt file snapshots and keeps the conversation, the way
 * "Restore code to here" asks.
 */
function grokRewindMode(
    scope: 'conversation' | 'files',
    target: Pick<ChatRewindTarget, 'restoreFiles'>,
): string {
    if (scope === 'files') return 'files_only';
    return target.restoreFiles ? 'all' : 'conversation_only';
}

function failedAction(scope: 'conversation' | 'files'): string {
    return scope === 'files' ? 'restore code' : 'rewind this conversation';
}

/**
 * `_x.ai/rewind/execute` returns the session to before one prompt and appends a rewind marker that a later
 * `session/load` honors; `mode: all` also restores Grok Build's per-prompt file snapshots, and `files_only` restores
 * them alone.
 */
export async function rewindGrokSession(
    connection: JsonRpcConnection,
    sessionId: string,
    target: ChatRewindTarget,
    scope: 'conversation' | 'files' = 'conversation',
): Promise<undefined> {
    const action = scope === 'files' ? 'restore' : 'edit';
    const point = await grokPromptIndex(connection, sessionId, target, action);
    let result: unknown;
    try {
        result = await connection.request(
            '_x.ai/rewind/execute',
            {
                sessionId,
                targetPromptIndex: point,
                force: true,
                mode: grokRewindMode(scope, target),
            },
            REWIND_REQUEST_TIMEOUT_MS,
        );
    } catch (error) {
        if (!(error instanceof JsonRpcRequestError)) throw error;
        throw new CaxriError('UNAVAILABLE', `Grok Build could not ${failedAction(scope)}`);
    }
    if (!isRecord(result) || result.success !== true)
        throw new CaxriError(
            'UNAVAILABLE',
            clip(
                `Grok Build could not ${failedAction(scope)}${
                    isRecord(result) && stringField(result.error)
                        ? `: ${stringField(result.error)}`
                        : ''
                }`,
                300,
            ),
        );
    return undefined;
}

/**
 * `_x.ai/session/fork` copies the session's files up to before one prompt into a new session (the same index a rewind
 * takes) without opening it; the new Chat opens it with `session/load`.
 */
export async function forkGrokSession(
    connection: JsonRpcConnection,
    source: { sessionId: string; cwd: string },
    target: ChatForkTarget,
): Promise<string> {
    const point = await grokPromptIndex(connection, source.sessionId, target, 'fork');
    let forked: unknown;
    try {
        forked = await connection.request(
            '_x.ai/session/fork',
            {
                sourceSessionId: source.sessionId,
                sourceCwd: source.cwd,
                newCwd: source.cwd,
                targetPromptIndex: point,
            },
            REWIND_REQUEST_TIMEOUT_MS,
        );
    } catch (error) {
        if (!(error instanceof JsonRpcRequestError)) throw error;
        throw new CaxriError('UNAVAILABLE', 'Grok Build could not fork this conversation');
    }
    const id = isRecord(forked) ? stringField(forked.newSessionId) : undefined;
    if (!id) throw new CaxriError('UNAVAILABLE', 'Grok Build did not report the forked session');
    return id;
}
