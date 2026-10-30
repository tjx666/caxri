import { join } from 'node:path';

import { sessionRenameTitleSchema } from '@caxri/protocol';
import Database from 'better-sqlite3';

import type { AgentEnvironment, AgentSnapshotContext, LocalAgentState } from '../../contract';
import { isOpaqueAgentSessionId } from '../../contract';
import { antigravityStateDirectory } from './paths';

/**
 * Reads only the title Antigravity generated for the exact conversation a validated lifecycle hook already bound to
 * this Terminal, from its `conversation_summaries` index. Identity and activity stay hook-owned, so an unbound Terminal
 * reads nothing and the result carries no `sessionId` or `status`.
 *
 * `title` is Antigravity's own summary of the conversation (empty until it generates one); the raw first prompt lives
 * in `preview`, which the query never selects. Verified against `agy` 1.4.11.
 */
export function readAntigravityState(
    context: AgentSnapshotContext,
    environment: AgentEnvironment,
): Promise<LocalAgentState | undefined> {
    const { agentSessionId } = context;
    if (!agentSessionId || !isOpaqueAgentSessionId(agentSessionId))
        return Promise.resolve(undefined);
    let database: Database.Database | undefined;
    let row: { title?: unknown } | undefined;
    try {
        database = new Database(
            join(antigravityStateDirectory(environment), 'conversation_summaries.db'),
            { fileMustExist: true, readonly: true },
        );
        row = database
            .prepare('SELECT title FROM conversation_summaries WHERE conversation_id = ?')
            .get(agentSessionId) as { title?: unknown } | undefined;
    } catch {
        // A missing index, a schema Antigravity changed, or a write lock all mean no title to publish.
        return Promise.resolve(undefined);
    } finally {
        database?.close();
    }
    /**
     * Provider metadata is untrusted model-written text that reaches the Session list, the Terminal tab, and native
     * notifications, so it must satisfy the same single-line, bounded contract as a user-entered Session name.
     */
    const title = sessionRenameTitleSchema.safeParse(row?.title);
    return Promise.resolve(
        title.success ? { title: title.data, titleSource: 'automatic' } : undefined,
    );
}
