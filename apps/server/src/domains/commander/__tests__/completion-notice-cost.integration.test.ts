import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentDelegationReceipt } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import type { CaxriDatabaseConnection } from '../../db';
import { CaxriDatabase } from '../../db';
import { createCommanderCompletionNotifier } from '../completion-notice';

/**
 * The Commander record's created-Session cap (`MAX_COMMANDER_SESSIONS` in `service.ts`).
 */
const MAX_COMMANDER_SESSIONS = 1_000;

/**
 * A real database whose Commander record lists the maximum number of created Sessions. Only the first exists; the rest
 * are stale IDs, which `agentCommanderRows` still looks up one by one to filter out.
 */
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-notice-cost-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const commanderProject = database.createProject(join(directory, 'commander'));
    const commanderSession = database.createSession(commanderProject.id, null).session;
    const commanderTerminal = database.createTerminal(commanderSession.id, 'codex', directory);
    const userProject = database.createProject(join(directory, 'repository'));
    const userSession = database.createSession(userProject.id, null).session;
    const shellTerminal = database.createTerminal(userSession.id, 'shell', directory);
    const staleIds = Array.from(
        { length: MAX_COMMANDER_SESSIONS - 1 },
        (_, index) => `stale-session-${index}`,
    );
    database.setAppState('agentCommander', {
        projectId: commanderProject.id,
        sessionId: commanderSession.id,
        terminalId: commanderTerminal.id,
        sessionIds: [userSession.id, ...staleIds],
    });
    /**
     * Both `agentCommanderRows` and the repository getters reach Session rows through this one model, so the spy sees
     * every Session lookup whichever path makes it.
     */
    const connection = (database as unknown as { db: CaxriDatabaseConnection }).db;
    const sessionLookups = vi.spyOn(connection.sessions, 'get');
    const writeAgentExact = vi.fn(() => true);
    const notifier = createCommanderCompletionNotifier({
        agentChat: { send: vi.fn() },
        coordinator: { hasIdleProof: () => true },
        database,
        terminals: { inputEpoch: () => 0, writeAgentExact },
    });
    const staleLookups = () =>
        sessionLookups.mock.calls.filter(([id]) => id.startsWith('stale-session-')).length;
    const signal = (
        terminalId: string,
        phase: AgentLifecycleSignal['phase'],
        agentTurnId?: string,
    ): AgentLifecycleSignal => ({
        phase,
        launchId: 'launch-1',
        provider: 'codex',
        terminalId,
        ...(agentTurnId && { agentTurnId }),
    });
    const receipt = (): AgentDelegationReceipt => ({
        delegationId: 'delegation-1',
        projectId: userProject.id,
        sessionId: userSession.id,
        callerTerminalId: commanderTerminal.id,
        provider: 'codex',
        status: 'completed',
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
    });
    return {
        commanderTerminal,
        database,
        notifier,
        receipt,
        shellTerminal,
        signal,
        staleLookups,
        writeAgentExact,
    };
}

describe('CommanderCompletionNotifier lookup cost', () => {
    it('handles input and lifecycle signals for an ordinary Terminal without any per-Session lookup', async () => {
        const f = await fixture();
        // Control: the full row read does pay one lookup per stored Session, so the spy can see that cost.
        f.database.agentCommanderRows();
        expect(f.staleLookups()).toBe(MAX_COMMANDER_SESSIONS - 1);
        const before = f.staleLookups();

        for (const key of 'echo hello\r') f.notifier.observeInput(f.shellTerminal.id, key);
        f.notifier.onLifecycleApplied(f.signal(f.shellTerminal.id, 'turnStarted'));
        f.notifier.onLifecycleApplied(f.signal(f.shellTerminal.id, 'turnFinished', 'turn-1'));
        expect(f.notifier.launchPrompt(f.shellTerminal.id)).toBeUndefined();

        expect(f.staleLookups()).toBe(before);
    });

    it('keeps delivering to the Commander Terminal, with the Session list read only for its own receipt', async () => {
        const f = await fixture();
        f.notifier.onLifecycleApplied(f.signal(f.commanderTerminal.id, 'turnStarted'));
        f.notifier.observeInput(f.commanderTerminal.id, 'a');
        f.notifier.onLifecycleApplied(f.signal(f.commanderTerminal.id, 'turnFinished', 'turn-1'));
        expect(f.staleLookups()).toBe(0);

        f.notifier.notifyReceiptChanged(f.receipt());
        expect(f.writeAgentExact).toHaveBeenCalledWith(
            f.commanderTerminal.id,
            expect.stringContaining('delegation delegation-1'),
            'launch-1',
            'delegation',
            expect.any(Function),
        );
        expect(f.staleLookups()).toBe(MAX_COMMANDER_SESSIONS - 1);

        // A receipt some other caller dispatched never reaches the Session list.
        const before = f.staleLookups();
        f.notifier.notifyReceiptChanged({
            ...f.receipt(),
            callerTerminalId: f.shellTerminal.id,
            revision: 2,
        });
        expect(f.staleLookups()).toBe(before);
    });
});
