import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentProviderCatalog, CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { Mock } from 'vitest';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

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

/**
 * The fields of the only `event` record written so far.
 */
function loggedFields(logWrite: Mock<StructuredLogger['write']>, event: string) {
    const records = logWrite.mock.calls.filter(([, name]) => name === event);
    expect(records).toHaveLength(1);
    return records[0][2]?.fields;
}

describe('AgentChatService rewind', () => {
    it.each<Provider>(['claude', 'codex', 'grok'])(
        'edits a %s conversation from an earlier message',
        async (provider) => {
            const { service, terminal, until, secondId, logWrite } = await threeTurns(provider);
            await service.rewind(terminal.id, {
                itemId: secondId,
                restoreFiles: false,
                message: { text: 'second, rewritten' },
            });
            expect(loggedFields(logWrite, 'agent_chat.rewound')).toMatchObject({
                outcome: 'rewound',
                reason: null,
                code: null,
                removedTurns: 2,
            });
            const edited = await until((snapshot) => isSettled(snapshot, 2));
            expect(userTexts(edited)).toEqual(['first', 'second, rewritten']);

            // The provider's own record agrees: a later resume shows the same two turns, not the rewound ones.
            await service.restart(terminal.id);
            expect(userTexts(service.read(terminal.id))).toEqual(['first', 'second, rewritten']);
        },
    );

    it('edits a Grok conversation after a steered message, which has no rewind point of its own (#1721)', async () => {
        const { service, terminal, until } = await fixture({ provider: 'grok' });
        await service.send(terminal.id, { text: 'slow first' });
        await until((snapshot) =>
            snapshot.items.some((item) => item.type === 'agentMessage' && item.text.length > 0),
        );
        await service.send(terminal.id, { text: 'steered in' }, 'steer');
        await until((snapshot) =>
            snapshot.items.some(
                (item) => item.type === 'agentMessage' && item.text.includes('Heard: steered in'),
            ),
        );
        await service.interrupt(terminal.id);
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'interrupted');
        await service.send(terminal.id, { text: 'second' });
        await until((snapshot) => snapshot.turns.length === 2 && !snapshot.activeTurnId);
        // After a restart the interjection replays inside the first turn, so both live and resumed Chats map turns onto
        // Grok Build's points one to one.
        await service.restart(terminal.id);
        const second = service
            .read(terminal.id)
            .items.find((item) => item.type === 'userMessage' && item.text === 'second');
        if (!second) throw new Error('The second message is missing');
        await service.rewind(terminal.id, {
            itemId: second.id,
            restoreFiles: false,
            message: { text: 'second, rewritten' },
        });
        const edited = await until(
            (snapshot) => snapshot.turns.length === 2 && !snapshot.activeTurnId,
        );
        expect(userTexts(edited)).toEqual(['slow first', 'steered in', 'second, rewritten']);
    });

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
        const { service, terminal, secondId, fakeLog, logWrite } = await threeTurns('claude');
        await service.restoreFiles(terminal.id, secondId);
        expect(loggedFields(logWrite, 'agent_chat.files_restored')).toMatchObject({
            outcome: 'restored',
            reason: null,
            code: null,
            restoredTurns: 2,
        });
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
        expect(loggedFields(codex.logWrite, 'agent_chat.files_restored')).toMatchObject({
            outcome: 'refused',
            reason: 'capability',
            code: 'VALIDATION',
        });

        const { service, terminal, until, secondId, fakeLog, logWrite } =
            await threeTurns('claude');
        await service.send(terminal.id, { text: 'slow' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await expect(service.restoreFiles(terminal.id, secondId)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(loggedFields(logWrite, 'agent_chat.files_restored')).toMatchObject({
            outcome: 'refused',
            reason: 'turnRunning',
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
        const { service, terminal, secondId, fakeLog, logWrite } = await threeTurns('codex');
        await expect(
            service.rewind(terminal.id, {
                itemId: secondId,
                restoreFiles: true,
                message: { text: 'again' },
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(loggedFields(logWrite, 'agent_chat.rewound')).toMatchObject({
            outcome: 'refused',
            reason: 'capability',
            code: 'VALIDATION',
        });
        expect(await fakeLog('codex', 'thread-reverts.jsonl')).toEqual([]);
        expect(userTexts(service.read(terminal.id))).toEqual(['first', 'second', 'third']);
    });

    it('refuses while a turn is running', async () => {
        const { service, terminal, until, secondId, logWrite } = await threeTurns('codex');
        await service.send(terminal.id, { text: 'slow' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await expect(
            service.rewind(terminal.id, {
                itemId: secondId,
                restoreFiles: false,
                message: { text: 'again' },
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(loggedFields(logWrite, 'agent_chat.rewound')).toMatchObject({
            outcome: 'refused',
            reason: 'turnRunning',
            code: 'CONFLICT',
        });
    });

    it('logs resendFailed when the edited message is not sent after the rewind', async () => {
        const { service, terminal, secondId, logWrite } = await threeTurns('codex');
        vi.spyOn(service, 'send').mockRejectedValueOnce(
            new CaxriError('UNAVAILABLE', 'The provider stopped'),
        );
        await expect(
            service.rewind(terminal.id, {
                itemId: secondId,
                restoreFiles: false,
                message: { text: 'again' },
            }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(loggedFields(logWrite, 'agent_chat.rewound')).toMatchObject({
            outcome: 'resendFailed',
            reason: null,
            code: 'UNAVAILABLE',
            removedTurns: 2,
        });
    });

    it('logs a driver without file restore as a failed capability, not a refusal', async () => {
        const { service, terminal, secondId, logWrite } = await threeTurns('codex');
        // A catalog entry that promises file restore to a driver whose session cannot do it.
        const { capabilities } = agentProviderCatalog.codex;
        const promised = capabilities.chatRewindFiles;
        Object.assign(capabilities, { chatRewindFiles: true });
        onTestFinished(() => {
            Object.assign(capabilities, { chatRewindFiles: promised });
        });
        await expect(service.restoreFiles(terminal.id, secondId)).rejects.toMatchObject({
            code: 'VALIDATION',
        });
        expect(loggedFields(logWrite, 'agent_chat.files_restored')).toMatchObject({
            outcome: 'failed',
            reason: 'capability',
            code: 'VALIDATION',
        });
    });
});
