import type { SessionRecord } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../../agents';
import { CommanderCompletionNotifier } from '../completion-notice';
import { commanderRowReader } from './commander-rows-fake';
import { pendingStore } from './pending-notices-fake';

/**
 * A notifier over in-memory Commander rows, pending notices, idle proofs, and input epochs, driven turn by turn.
 */
export interface Fixture {
    currentEpoch: number;
    idleProof: { launchId: string; turnId: string } | undefined;
    notifier: CommanderCompletionNotifier;
    notices: ReturnType<typeof pendingStore>;
    rows: { terminalId: string | undefined; sessionIds: readonly string[] };
    session: SessionRecord;
    type(data?: string): void;
    startTurn(launchId: string): void;
    finishTurn(launchId: string, turnId: string): void;
    writeCalls: Array<{ data: string; launchId: string; terminalId: string }>;
    writeResult: boolean;
}

export const COMMANDER_TERMINAL_ID = 'commander-terminal';

export function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: 'commander-session',
        projectId: 'commander-project',
        workbenchProjectId: 'commander-project',
        rootPath: '/workspace/commander',
        createdAt: 1,
        lastOpenedAt: 1,
        lastSessionActivityAt: 1,
        sidebarOrder: 0,
        lastSessionActivityReason: 'created',
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        displayTitle: 'Agent Commander',
        titleMode: 'automatic',
        ...overrides,
    };
}

/**
 * A Commander that owns `session-1` on `COMMANDER_TERMINAL_ID`, idle, over the given pending-notice store.
 */
export function commanderDatabase(commanderPendingNotices: ReturnType<typeof pendingStore>) {
    return {
        agentCommanderRows: () => ({
            terminalId: COMMANDER_TERMINAL_ID,
            sessionIds: ['session-1'],
            projectId: 'commander-project',
            sessionId: 'commander-session',
        }),
        ...commanderRowReader(() => COMMANDER_TERMINAL_ID),
        getSession: () => session(),
        commanderPendingNotices,
    };
}

export function signal(
    overrides: Partial<AgentLifecycleSignal> & Pick<AgentLifecycleSignal, 'phase'>,
) {
    return {
        launchId: 'launch-1',
        provider: 'codex',
        terminalId: COMMANDER_TERMINAL_ID,
        ...overrides,
    } satisfies AgentLifecycleSignal;
}

export function fixture(): Fixture {
    const state: Fixture = {
        currentEpoch: 0,
        idleProof: undefined,
        rows: { terminalId: COMMANDER_TERMINAL_ID, sessionIds: ['session-1', 'session-2'] },
        session: session(),
        writeCalls: [],
        writeResult: true,
        notices: pendingStore(),
        notifier: undefined as unknown as CommanderCompletionNotifier,
        type(data = 'a') {
            state.currentEpoch += 1;
            state.notifier.observeInput(COMMANDER_TERMINAL_ID, data);
        },
        startTurn(launchId) {
            // A real coordinator invalidates the previous idle proof for any signal other than `turnFinished`.
            state.idleProof = undefined;
            state.notifier.onLifecycleApplied(signal({ phase: 'turnStarted', launchId }));
        },
        finishTurn(launchId, turnId) {
            state.idleProof = { launchId, turnId };
            state.notifier.onLifecycleApplied(
                signal({ phase: 'turnFinished', launchId, agentTurnId: turnId }),
            );
        },
    };
    state.notifier = new CommanderCompletionNotifier({
        database: {
            agentCommanderRows: () =>
                state.rows.terminalId
                    ? {
                          ...state.rows,
                          projectId: 'commander-project',
                          sessionId: 'commander-session',
                      }
                    : undefined,
            ...commanderRowReader(() => state.rows.terminalId),
            getSession: () => state.session,
            commanderPendingNotices: state.notices,
        },
        hasIdleProof: (terminalId, launchId, turnId) => {
            const proof = state.idleProof;
            return (
                terminalId === COMMANDER_TERMINAL_ID &&
                proof?.launchId === launchId &&
                proof.turnId === turnId
            );
        },
        inputEpoch: () => state.currentEpoch,
        write: (terminalId, data, launchId, onDelivered) => {
            state.writeCalls.push({ data, launchId, terminalId });
            onDelivered?.(state.writeResult);
            return state.writeResult;
        },
    });
    return state;
}
