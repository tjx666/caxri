import type { SessionRecord } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../../agents';
import { BotCompletionNotifier } from '../completion-notice';
import { botRowReader } from './bot-rows-fake';
import { pendingStore } from './pending-notices-fake';

/**
 * A notifier over in-memory Caxri Bot rows, pending notices, idle proofs, and input epochs, driven turn by turn.
 */
export interface Fixture {
    currentEpoch: number;
    idleProof: { launchId: string; turnId: string } | undefined;
    notifier: BotCompletionNotifier;
    notices: ReturnType<typeof pendingStore>;
    rows: { terminalId: string | undefined; sessionIds: readonly string[] };
    session: SessionRecord;
    type(data?: string): void;
    startTurn(launchId: string): void;
    finishTurn(launchId: string, turnId: string): void;
    writeCalls: Array<{ data: string; launchId: string; terminalId: string }>;
    writeResult: boolean;
}

export const BOT_TERMINAL_ID = 'bot-terminal';

export function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: 'bot-session',
        projectId: 'bot-project',
        workbenchRootProjectId: 'bot-project',
        rootPath: '/workspace/bot',
        createdAt: 1,
        lastVisitedAt: 1,
        sessionActivityAt: 1,
        sidebarOrder: 0,
        sessionActivityReason: 'created',
        agentActivityState: 'idle',
        attentionGeneration: 0,
        acknowledgedAttentionGeneration: 0,
        hasUnread: false,
        title: 'Caxri Bot',
        titleMode: 'automatic',
        ...overrides,
    };
}

/**
 * A Caxri Bot that owns `session-1` on `BOT_TERMINAL_ID`, idle, over the given pending-notice store.
 */
export function botDatabase(botPendingNotices: ReturnType<typeof pendingStore>) {
    return {
        caxriBotRows: () => ({
            terminalId: BOT_TERMINAL_ID,
            sessionIds: ['session-1'],
            projectId: 'bot-project',
            sessionId: 'bot-session',
        }),
        ...botRowReader(() => BOT_TERMINAL_ID),
        getSession: () => session(),
        botPendingNotices,
    };
}

export function signal(
    overrides: Partial<AgentLifecycleSignal> & Pick<AgentLifecycleSignal, 'phase'>,
) {
    return {
        launchId: 'launch-1',
        provider: 'codex',
        terminalId: BOT_TERMINAL_ID,
        ...overrides,
    } satisfies AgentLifecycleSignal;
}

export function fixture(): Fixture {
    const state: Fixture = {
        currentEpoch: 0,
        idleProof: undefined,
        rows: { terminalId: BOT_TERMINAL_ID, sessionIds: ['session-1', 'session-2'] },
        session: session(),
        writeCalls: [],
        writeResult: true,
        notices: pendingStore(),
        notifier: undefined as unknown as BotCompletionNotifier,
        type(data = 'a') {
            state.currentEpoch += 1;
            state.notifier.observeInput(BOT_TERMINAL_ID, data);
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
    state.notifier = new BotCompletionNotifier({
        database: {
            caxriBotRows: () =>
                state.rows.terminalId
                    ? {
                          ...state.rows,
                          projectId: 'bot-project',
                          sessionId: 'bot-session',
                      }
                    : undefined,
            ...botRowReader(() => state.rows.terminalId),
            getSession: () => state.session,
            botPendingNotices: state.notices,
        },
        hasIdleProof: (terminalId, launchId, turnId) => {
            const proof = state.idleProof;
            return (
                terminalId === BOT_TERMINAL_ID &&
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
