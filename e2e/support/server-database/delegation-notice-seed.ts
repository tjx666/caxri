import { join } from 'node:path';

import { chatTextDigest } from '../../../apps/server/src/domains/agent-chat/chat-turn-answer';
import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    testDirectory: string;
    projectId: string;
    sessionId: string;
    /**
     * The exact notice text the Chat is about to receive; its digest is what the Chat recognizes.
     */
    text: string;
    /**
     * Titles of the child Sessions the notice reports, one item each, in order.
     */
    childTitles: string[];
    /**
     * The closed event of each item, aligned with `childTitles`.
     */
    events: Array<'completed' | 'failed' | 'handed_back' | 'question'>;
}

/**
 * Creates the child Sessions a settlement notice names and records the notice as delivered to the Chat of `sessionId`,
 * as Server Core does before writing the text. Returns the child Session IDs.
 */
export function run(input: Input): string[] {
    const database = new CaxriDatabase(join(input.testDirectory, 'user-data', 'caxri.db'));
    try {
        const terminal = database.listTerminals(input.sessionId).at(0);
        if (!terminal) throw new Error('The Chat Session has no Terminal');
        const children = input.childTitles.map(
            (title) =>
                database.createSession(input.projectId, 'codex', undefined, {
                    selection: 'preserve',
                    title,
                }).session,
        );
        database.agentDelegations.noticeDeliveries.record(
            terminal.id,
            chatTextDigest(input.text.trim()),
            {
                items: children.map((child, index) => ({
                    delegationId: `dispatch-${String(index).repeat(64)}`,
                    sessionId: child.id,
                    event: input.events[index],
                })),
            },
            Date.now(),
        );
        return children.map((child) => child.id);
    } finally {
        database.close();
    }
}
