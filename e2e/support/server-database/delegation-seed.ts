import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    testDirectory: string;
    projectId: string;
    sessionId: string;
    prompt: string;
    recordedDelegation: string;
    botDelegation: string;
}

/**
 * Saves the delegation records a real launch would have written, so Server Core names the task the caller wrote when
 * each pointer arrives: the recorded delegation has no caller, the Bot delegation is called from Caxri Bot's own
 * Terminal, whose rows are seeded the way Caxri Bot records them. A real launch needs a delegated Agent; the bubble
 * only reads the records.
 */
export async function run(input: Input): Promise<void> {
    const { testDirectory, projectId, sessionId } = input;
    const database = new CaxriDatabase(join(testDirectory, 'user-data', 'caxri.db'));
    try {
        const botRoot = join(testDirectory, 'bot');
        await mkdir(botRoot);
        const botProject = database.createProject(botRoot);
        const bot = database.createSession(botProject.id, 'codex');
        database.setAppState('caxriBot', {
            projectId: botProject.id,
            sessionId: bot.session.id,
            terminalId: bot.terminal!.id,
            sessionIds: [],
        });
        const now = Date.now();
        for (const [delegationId, callerTerminalId] of [
            [input.recordedDelegation, undefined],
            [input.botDelegation, bot.terminal!.id],
        ] as const) {
            database.agentDelegations.insert({
                receipt: {
                    delegationId,
                    projectId,
                    sessionId,
                    provider: 'codex',
                    status: 'completed',
                    revision: 1,
                    createdAt: now,
                    updatedAt: now,
                    ...(callerTerminalId && { callerTerminalId }),
                },
                principal: { kind: 'human-cli', id: 'acceptance' },
                input: { projectId, sessionId, provider: 'codex', prompt: input.prompt },
                fingerprint: 'acceptance',
                promptDigest: '0'.repeat(64),
                frozenLaunch: { executable: 'codex', args: [] },
            });
        }
    } finally {
        database.close();
    }
}
