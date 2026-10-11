import { CaxriError } from '@caxri/protocol';

import { isRecord, stringField } from './chat-items';
import type { ChatForkTarget, ChatRewindTarget } from './chat-provider';
import type { JsonRpcConnection } from './json-rpc-connection';
import { JsonRpcRequestError } from './json-rpc-connection';

const REVERT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * `thread/revert` removes `beforeTurnId` and every later turn from the thread's own record (a new rollout under the
 * same thread id). It changes only the conversation: Codex keeps no file checkpoints, so file restore is refused before
 * this point (`capabilities.chatRewindFiles`). The restart that follows resumes the reverted thread.
 */
export async function revertCodexThread(
    connection: JsonRpcConnection,
    threadId: string | undefined,
    target: ChatRewindTarget,
): Promise<undefined> {
    if (target.restoreFiles) throw new CaxriError('VALIDATION', 'Codex cannot restore files');
    try {
        await connection.request(
            'thread/revert',
            { threadId, beforeTurnId: target.turnId },
            REVERT_REQUEST_TIMEOUT_MS,
        );
    } catch (error) {
        if (!(error instanceof JsonRpcRequestError)) throw error;
        throw new CaxriError(
            'UNAVAILABLE',
            /unknown variant/u.test(error.message)
                ? 'This Codex CLI version cannot rewind a conversation; update Codex'
                : 'Codex could not rewind this conversation',
        );
    }
    return undefined;
}

/**
 * `thread/fork` with `beforeTurnId` copies the thread up to just before `target.turnId` into a new thread (a rollout of
 * its own) and leaves the source untouched. The app-server also loads the fork, so this process unsubscribes from it at
 * once: the new Chat resumes it in its own app-server, and two processes must not drive one thread.
 */
export async function forkCodexThread(
    connection: JsonRpcConnection,
    threadId: string | undefined,
    target: ChatForkTarget,
): Promise<string> {
    let forked: unknown;
    try {
        forked = await connection.request(
            'thread/fork',
            { threadId, beforeTurnId: target.turnId },
            REVERT_REQUEST_TIMEOUT_MS,
        );
    } catch (error) {
        if (!(error instanceof JsonRpcRequestError)) throw error;
        throw new CaxriError(
            'UNAVAILABLE',
            /unknown variant|beforeTurnId/u.test(error.message)
                ? 'This Codex CLI version cannot fork a conversation; update Codex'
                : 'Codex could not fork this conversation',
        );
    }
    const id =
        isRecord(forked) && isRecord(forked.thread) ? stringField(forked.thread.id) : undefined;
    if (!id) throw new CaxriError('UNAVAILABLE', 'Codex did not report the forked thread');
    try {
        await connection.request('thread/unsubscribe', { threadId: id }, REVERT_REQUEST_TIMEOUT_MS);
    } catch {
        // The fork is already written; a subscription left open ends with this app-server.
    }
    return id;
}
