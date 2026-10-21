import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import { ChatStates } from '../chat-states';

async function setup() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-chat-floors-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(join(directory, 'project'));
    const { session } = database.createSession(project.id, null);
    const chat = database.createTerminal(session.id, 'claude', undefined, 'chat');
    const states = new ChatStates({
        database,
        enqueue: () => Promise.resolve(),
        logger: { write: vi.fn() } as unknown as StructuredLogger,
        send: vi.fn(),
    });
    return { chat, database, states };
}

function advance(states: ChatStates, terminalId: string): number {
    states.open(terminalId);
    states.setStatus(terminalId, 'ready');
    return states.get(terminalId)!.projection.snapshot.revision;
}

describe('ChatStates revision floors', () => {
    it('keeps the floor across a restart so Clients holding the old revision still re-read', async () => {
        const { chat, states } = await setup();
        const before = advance(states, chat.id);

        states.forget(chat.id);

        expect(states.open(chat.id).projection.snapshot.revision).toBeGreaterThan(before);
    });

    it('keeps the floor when a Chat closes but its Terminal row survives (archive, surface switch)', async () => {
        const { chat, states } = await setup();
        const before = advance(states, chat.id);

        states.forget(chat.id, true);

        expect(states.open(chat.id).projection.snapshot.revision).toBeGreaterThan(before);
    });

    it('drops the floor once the Terminal row is gone (Terminal close, Session delete)', async () => {
        const { chat, database, states } = await setup();
        advance(states, chat.id);
        database.closeTerminal(chat.id);

        states.forget(chat.id, true);

        expect(states.open(chat.id).projection.snapshot.revision).toBe(0);
    });
});
