import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

type Provider = 'claude' | 'codex' | 'grok';

function userTexts(snapshot: AgentChatSnapshot): string[] {
    return snapshot.items.flatMap((item) => (item.type === 'userMessage' ? [item.text] : []));
}

function isSettled(snapshot: AgentChatSnapshot, turns: number): boolean {
    return (
        snapshot.turns.length === turns &&
        !snapshot.activeTurnId &&
        snapshot.turns.every((turn) => turn.status === 'completed')
    );
}

/**
 * Starts a Chat with three completed turns, `first`, `second`, and `third`.
 */
async function threeTurns(provider: Provider) {
    const context = await fixture({ provider });
    for (const [index, text] of ['first', 'second', 'third'].entries()) {
        // eslint-disable-next-line no-await-in-loop -- each turn must finish before the next is sent
        await context.service.send(context.terminal.id, { text });
        // eslint-disable-next-line no-await-in-loop -- see above
        await context.until((snapshot) => isSettled(snapshot, index + 1));
    }
    const snapshot = context.client();
    const second = snapshot.items.find(
        (item) => item.type === 'userMessage' && item.text === 'second',
    );
    if (!second) throw new Error('The second message is missing');
    return { ...context, secondId: second.id };
}

describe('AgentChatService rewind', () => {
    it.each<Provider>(['claude', 'codex', 'grok'])(
        'edits a %s conversation from an earlier message',
        async (provider) => {
            const { service, terminal, until, secondId } = await threeTurns(provider);
            await service.rewind(terminal.id, {
                itemId: secondId,
                restoreFiles: false,
                message: { text: 'second, rewritten' },
            });
            const edited = await until((snapshot) => isSettled(snapshot, 2));
            expect(userTexts(edited)).toEqual(['first', 'second, rewritten']);

            // The provider's own record agrees: a later resume shows the same two turns, not the rewound ones.
            await service.restart(terminal.id);
            expect(userTexts(service.read(terminal.id))).toEqual(['first', 'second, rewritten']);
        },
    );

    it('restores Claude files through the prompt checkpoint', async () => {
        const { service, terminal, until, secondId, fakeLog } = await threeTurns('claude');
        await service.rewind(terminal.id, {
            itemId: secondId,
            restoreFiles: true,
            message: { text: 'again' },
        });
        await until((snapshot) => isSettled(snapshot, 2));
        expect(await fakeLog('claude', 'rewinds.jsonl')).toEqual([
            { userMessageId: secondId, dryRun: true },
            { userMessageId: secondId, dryRun: false },
        ]);
    });

    it('restores Grok files with the all mode', async () => {
        const { service, terminal, until, secondId, fakeLog } = await threeTurns('grok');
        await service.rewind(terminal.id, {
            itemId: secondId,
            restoreFiles: true,
            message: { text: 'again' },
        });
        await until((snapshot) => isSettled(snapshot, 2));
        expect(await fakeLog('grok', 'rewinds.jsonl')).toEqual([
            expect.objectContaining({ targetPromptIndex: 1, mode: 'all' }),
        ]);
    });

    it('restores Claude code to an earlier message and keeps the conversation', async () => {
        const { service, terminal, secondId, fakeLog } = await threeTurns('claude');
        await service.restoreFiles(terminal.id, secondId);
        expect(await fakeLog('claude', 'rewinds.jsonl')).toEqual([
            { userMessageId: secondId, dryRun: true },
            { userMessageId: secondId, dryRun: false },
        ]);
        expect(userTexts(service.read(terminal.id))).toEqual(['first', 'second', 'third']);
    });

    it('restores Grok code with the files-only mode and keeps the conversation', async () => {
        const { service, terminal, secondId, fakeLog } = await threeTurns('grok');
        await service.restoreFiles(terminal.id, secondId);
        expect(await fakeLog('grok', 'rewinds.jsonl')).toEqual([
            expect.objectContaining({ targetPromptIndex: 1, mode: 'files_only' }),
        ]);
        // Grok Build's own record keeps every turn too.
        await service.restart(terminal.id);
        expect(userTexts(service.read(terminal.id))).toEqual(['first', 'second', 'third']);
    });

    it('refuses to restore Codex code, or any code while a turn runs', async () => {
        const codex = await threeTurns('codex');
        await expect(
            codex.service.restoreFiles(codex.terminal.id, codex.secondId),
        ).rejects.toMatchObject({ code: 'VALIDATION' });

        const { service, terminal, until, secondId, fakeLog } = await threeTurns('claude');
        await service.send(terminal.id, { text: 'slow' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await expect(service.restoreFiles(terminal.id, secondId)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(await fakeLog('claude', 'rewinds.jsonl')).toEqual([]);
    });

    it('starts a new Claude session when the first message is edited', async () => {
        const { service, terminal, until, coordinator, client } = await threeTurns('claude');
        const first = client().items[0];
        await service.rewind(terminal.id, {
            itemId: first.id,
            restoreFiles: false,
            message: { text: 'from scratch' },
        });
        expect(coordinator.prepareTerminalStart).toHaveBeenCalledWith(terminal.id);
        await until((snapshot) => userTexts(snapshot).includes('from scratch'));
    });

    it('refuses to restore Codex files and leaves the conversation alone', async () => {
        const { service, terminal, secondId, fakeLog } = await threeTurns('codex');
        await expect(
            service.rewind(terminal.id, {
                itemId: secondId,
                restoreFiles: true,
                message: { text: 'again' },
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(await fakeLog('codex', 'thread-reverts.jsonl')).toEqual([]);
        expect(userTexts(service.read(terminal.id))).toEqual(['first', 'second', 'third']);
    });

    it('refuses while a turn is running', async () => {
        const { service, terminal, until, secondId } = await threeTurns('codex');
        await service.send(terminal.id, { text: 'slow' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await expect(
            service.rewind(terminal.id, {
                itemId: secondId,
                restoreFiles: false,
                message: { text: 'again' },
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
});
