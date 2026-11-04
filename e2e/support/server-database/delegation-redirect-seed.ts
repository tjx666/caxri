import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    testDirectory: string;
    projectId: string;
    sessionId: string;
    delegationId: string;
    operationId: string;
    /**
     * The Session title the redirect reads as coming from.
     */
    callerTitle: string;
    /**
     * The exact new direction the redirect claim covers.
     */
    text: string;
}

/**
 * Saves the delegation record of a running task whose delegating Agent (a titled Session with an Agent Terminal)
 * redirected it, with the delivered claim for `text`. Server Core recognizes the redirect envelope in the child's Chat
 * only when the record holds this claim, so the Chat reads "Updated direction from <title>" instead of raw text.
 */
export function run(input: Input): void {
    const database = new CaxriDatabase(join(input.testDirectory, 'user-data', 'caxri.db'));
    try {
        const caller = database.createSession(input.projectId, 'codex', undefined, {
            selection: 'preserve',
            title: input.callerTitle,
        });
        const now = Date.now();
        database.agentDelegations.insert({
            receipt: {
                delegationId: input.delegationId,
                projectId: input.projectId,
                sessionId: input.sessionId,
                provider: 'codex',
                status: 'running',
                revision: 1,
                createdAt: now,
                updatedAt: now,
                callerTerminalId: caller.terminal!.id,
            },
            principal: { kind: 'human-cli', id: 'acceptance' },
            input: {
                projectId: input.projectId,
                sessionId: input.sessionId,
                provider: 'codex',
                prompt: 'Synthetic delegated task',
            },
            fingerprint: 'acceptance',
            promptDigest: '0'.repeat(64),
            frozenLaunch: { executable: 'codex', args: [] },
            redirects: [
                {
                    operationId: input.operationId,
                    digest: createHash('sha256').update(input.text).digest('hex'),
                    state: 'delivered',
                    at: now,
                },
            ],
        });
    } finally {
        database.close();
    }
}
