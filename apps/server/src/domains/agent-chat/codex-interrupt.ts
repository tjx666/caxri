import { CaxriError } from '@caxri/protocol';

import type { JsonRpcConnection } from './json-rpc-connection';

/**
 * The interrupt response is held until the turn actually aborts. A provider that never answers is stopped instead so
 * the Chat cannot stay stuck in a running turn.
 */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * Asks Codex to abort `turnId`. Resolves `true` when Codex never answered in time, so the caller stops the process.
 */
export async function didInterruptTimeout(
    connection: JsonRpcConnection,
    threadId: string | undefined,
    turnId: string,
): Promise<boolean> {
    try {
        await connection.request('turn/interrupt', { threadId, turnId }, INTERRUPT_TIMEOUT_MS);
    } catch (error) {
        return error instanceof CaxriError && error.code === 'TIMEOUT';
        // Any other failure means the turn already ended between the read and the request; `turn/completed` settles
        // the projection.
    }
    return false;
}
