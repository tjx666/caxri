import { CaxriError } from '@caxri/protocol';

import type { ChatRewindTarget } from './chat-provider';
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
