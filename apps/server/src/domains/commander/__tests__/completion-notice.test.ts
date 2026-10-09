import type { AgentDelegationReceipt, SessionRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import {
    classifyCommanderCompletionNotice,
    CommanderCompletionNotifier,
    formatCommanderCompletionNotice,
} from '../completion-notice';

function receipt(overrides: Partial<AgentDelegationReceipt> = {}): AgentDelegationReceipt {
    return {
        delegationId: 'delegation-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        callerTerminalId: 'commander-terminal',
        provider: 'codex',
        status: 'completed',
        revision: 1,
        createdAt: 1,
        updatedAt: 2,
        ...overrides,
    };
}

describe('classifyCommanderCompletionNotice', () => {
    it.each([
        [{ status: 'completed' }, 'completed'],
        [{ status: 'failed' }, 'failed'],
        [{ status: 'answer_unavailable' }, 'failed'],
        [{ status: 'blocked', failure: 'startup_waiting' }, 'needsInput'],
        [{ status: 'blocked', failure: 'permission_required' }, 'needsInput'],
        [{ status: 'blocked', failure: 'rate_limited' }, undefined],
        [{ status: 'blocked' }, undefined],
        [{ status: 'running' }, undefined],
        [{ status: 'human_intervened' }, undefined],
        [{ status: 'interrupted' }, undefined],
        [{ status: 'launching' }, undefined],
    ] as const)('%o -> %s', (partial, expected) => {
        expect(classifyCommanderCompletionNotice(partial)).toBe(expected);
    });
});

describe('formatCommanderCompletionNotice', () => {
    it('formats a single transition on one prefixed line', () => {
        const text = formatCommanderCompletionNotice([
            { delegationId: 'd1', sessionId: 's1', status: 'completed' },
        ]);
        expect(text).toBe(
            '[Caxri notice] 1 delegation update: delegation d1 in Session s1 completed.',
        );
    });

    it('coalesces multiple transitions into one line', () => {
        const text = formatCommanderCompletionNotice([
            { delegationId: 'd1', sessionId: 's1', status: 'completed' },
            { delegationId: 'd2', sessionId: 's2', status: 'failed' },
            { delegationId: 'd3', sessionId: 's3', status: 'needsInput' },
        ]);
        expect(text).toBe(
            '[Caxri notice] 3 delegation updates: delegation d1 in Session s1 completed; ' +
                'delegation d2 in Session s2 failed; delegation d3 in Session s3 needs your input.',
        );
    });

    it('never lets an interpolated field introduce a control character or a newline', () => {
        const text = formatCommanderCompletionNotice([
            { delegationId: 'd1\u{7}\ninjected', sessionId: 's1', status: 'completed' },
        ]);
        // eslint-disable-next-line no-control-regex -- asserting the output contains none.
        expect(/[\u{0}-\u{1F}\u{7F}-\u{9F}]/u.test(text)).toBe(false);
        expect(text.includes('\n')).toBe(false);
    });
});

interface Fixture {
    currentEpoch: number;
    idleProof: { launchId: string; turnId: string } | undefined;
    notifier: CommanderCompletionNotifier;
    rows: { terminalId: string | undefined; sessionIds: readonly string[] };
    session: SessionRecord;
    type(): void;
    startTurn(launchId: string): void;
    finishTurn(launchId: string, turnId: string): void;
    writeCalls: Array<{ data: string; launchId: string; terminalId: string }>;
    writeResult: boolean;
}

const COMMANDER_TERMINAL_ID = 'commander-terminal';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
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

function signal(overrides: Partial<AgentLifecycleSignal> & Pick<AgentLifecycleSignal, 'phase'>) {
    return {
        launchId: 'launch-1',
        provider: 'codex',
        terminalId: COMMANDER_TERMINAL_ID,
        ...overrides,
    } satisfies AgentLifecycleSignal;
}

function fixture(): Fixture {
    const state: Fixture = {
        currentEpoch: 0,
        idleProof: undefined,
        rows: { terminalId: COMMANDER_TERMINAL_ID, sessionIds: ['session-1', 'session-2'] },
        session: session(),
        writeCalls: [],
        writeResult: true,
        notifier: undefined as unknown as CommanderCompletionNotifier,
        type() {
            state.currentEpoch += 1;
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
            getSession: () => state.session,
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

describe('CommanderCompletionNotifier', () => {
    let f: Fixture;

    beforeEach(() => {
        f = fixture();
    });

    it('delivers once the turn that was running when the delegation finished settles cleanly', () => {
        f.startTurn('launch-1');
        f.notifier.notifyReceiptChanged(receipt({ status: 'completed' }));
        expect(f.writeCalls).toHaveLength(0); // still mid-turn, no turnFinished yet
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls).toHaveLength(1);
        expect(f.writeCalls[0].terminalId).toBe(COMMANDER_TERMINAL_ID);
        expect(f.writeCalls[0].data).toContain('delegation delegation-1');
        expect(f.writeCalls[0].data.endsWith('\r')).toBe(true);
    });

    it('delivers immediately when the Commander is already idle before the transition arrives', () => {
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-1');
        f.notifier.notifyReceiptChanged(receipt({ status: 'completed' }));
        expect(f.writeCalls).toHaveLength(1);
    });

    it('coalesces several pending transitions into exactly one write', () => {
        f.startTurn('launch-1');
        f.notifier.notifyReceiptChanged(receipt({ delegationId: 'd1', status: 'completed' }));
        f.notifier.notifyReceiptChanged(
            receipt({ delegationId: 'd2', sessionId: 'session-2', status: 'failed', revision: 1 }),
        );
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls).toHaveLength(1);
        expect(f.writeCalls[0].data).toContain('2 delegation updates');
        expect(f.writeCalls[0].data).toContain('d1');
        expect(f.writeCalls[0].data).toContain('d2');
    });

    it('blocks injection while a draft was typed during the finished turn, and retries at the next clean idle point', () => {
        f.startTurn('launch-1');
        f.type(); // a draft keystroke during the turn
        f.notifier.notifyReceiptChanged(receipt({ status: 'completed' }));
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls).toHaveLength(0);
        // A second, clean turn on the same launch re-baselines and delivers the still-pending notice.
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-2');
        expect(f.writeCalls).toHaveLength(1);
    });

    it('blocks injection while a draft is typed after the turn finished, once a notice becomes pending', () => {
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-1'); // Commander goes idle with nothing pending yet
        f.type(); // a draft typed into the now-idle Commander
        f.notifier.notifyReceiptChanged(receipt({ status: 'completed' }));
        expect(f.writeCalls).toHaveLength(0);
        // A fresh, clean turn re-baselines against the draft and delivers.
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-2');
        expect(f.writeCalls).toHaveLength(1);
    });

    it('delivers after a finished Commander turn even though that turn left the Commander Session unread', () => {
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-1');
        // Every settled Commander turn raises `completed` attention on its own Session, and nothing ever marks that
        // Session read: the Commander window is not a Workbench selection. Gating on `hasUnread` would therefore
        // withhold every notice after the Commander's first turn.
        f.session = session({ attentionEpoch: 1, hasUnread: true, lastActivityState: 'completed' });
        f.notifier.notifyReceiptChanged(receipt({ status: 'completed' }));
        expect(f.writeCalls).toHaveLength(1);
    });

    it('blocks injection while a permission prompt is pending, and retries once it clears', () => {
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-1');
        f.session = session({ lastActivityState: 'waiting' });
        f.notifier.notifyReceiptChanged(receipt({ status: 'completed' }));
        expect(f.writeCalls).toHaveLength(0);
        f.finishTurn('launch-1', 'turn-2');
        expect(f.writeCalls).toHaveLength(0);
        f.session = session();
        f.finishTurn('launch-1', 'turn-3');
        expect(f.writeCalls).toHaveLength(1);
    });

    it('requires a fresh turn between deliveries, so a second transition cannot reuse an already-spent idle proof', () => {
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-1');
        f.notifier.notifyReceiptChanged(receipt({ delegationId: 'd1', status: 'completed' }));
        expect(f.writeCalls).toHaveLength(1);
        // A second, distinct transition arrives before Codex has actually started a new turn to process the line just
        // injected. The write never bumps `inputEpoch` and `hasIdleProof` still reports `turn-1` as settled, so
        // without consuming the finished-turn identity on delivery this would send a second time against a Terminal
        // this module can no longer prove is still idle.
        f.notifier.notifyReceiptChanged(
            receipt({ delegationId: 'd2', status: 'failed', revision: 1 }),
        );
        expect(f.writeCalls).toHaveLength(1); // deferred: the turn-1 idle proof was already spent
        // Only a fresh, clean turn re-proves idle and delivers the still-pending notice.
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-2');
        expect(f.writeCalls).toHaveLength(2);
        expect(f.writeCalls[1].data).toContain('d2');
    });

    it('never delivers the same transition twice for a duplicate receipt-changed call', () => {
        f.startTurn('launch-1');
        const r = receipt({ status: 'completed' });
        f.notifier.notifyReceiptChanged(r);
        f.notifier.notifyReceiptChanged(r);
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls).toHaveLength(1);
        // Nothing left pending; a later idle point must not resend.
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-2');
        expect(f.writeCalls).toHaveLength(1);
    });

    it('isolates a stale generation after a relaunch instead of writing against it', () => {
        f.startTurn('launch-1');
        f.finishTurn('launch-1', 'turn-1');
        f.notifier.notifyReceiptChanged(receipt({ delegationId: 'd1', status: 'completed' }));
        expect(f.writeCalls).toHaveLength(1);
        // The Commander relaunches: a new launch id, and the old idle proof is gone.
        f.idleProof = undefined;
        f.notifier.notifyReceiptChanged(
            receipt({ delegationId: 'd2', status: 'failed', revision: 1 }),
        );
        expect(f.writeCalls).toHaveLength(1); // still fenced: no settled turn on the new launch yet
        f.startTurn('launch-2');
        f.finishTurn('launch-2', 'turn-1');
        expect(f.writeCalls).toHaveLength(2);
        expect(f.writeCalls[1].launchId).toBe('launch-2');
        expect(f.writeCalls[1].data).toContain('d2');
        expect(f.writeCalls[1].data).not.toContain('d1');
    });

    /**
     * A follow-up refused at admission fails straight out of `requested` inside the `agent delegate create` call the
     * Commander is still waiting on, so the CLI already returned that failure.
     */
    it('skips a failure the admission call already returned to the Commander', () => {
        f.startTurn('launch-1');
        f.notifier.notifyReceiptChanged(
            receipt({ status: 'failed', failure: 'target_busy', revision: 2 }),
            receipt({ status: 'requested', revision: 1 }),
        );
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls).toHaveLength(0);
    });

    it('still notifies a failure that settled after the task launched', () => {
        f.startTurn('launch-1');
        f.notifier.notifyReceiptChanged(
            receipt({ status: 'failed', failure: 'rate_limited', revision: 5 }),
            receipt({ status: 'running', revision: 4 }),
        );
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls).toHaveLength(1);
        expect(f.writeCalls[0].data).toContain('failed');
    });

    it('ignores a receipt the Commander did not delegate itself', () => {
        f.startTurn('launch-1');
        f.notifier.notifyReceiptChanged(
            receipt({ callerTerminalId: 'some-other-terminal', status: 'completed' }),
        );
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls).toHaveLength(0);
    });

    it('ignores a receipt for a Session the Commander does not own', () => {
        f.startTurn('launch-1');
        f.notifier.notifyReceiptChanged(receipt({ sessionId: 'not-a-commander-session' }));
        f.finishTurn('launch-1', 'turn-1');
        expect(f.writeCalls).toHaveLength(0);
    });

    it('ignores lifecycle signals for a Terminal that is not the current Commander Terminal', () => {
        f.notifier.onLifecycleApplied(
            signal({ phase: 'turnStarted', terminalId: 'other-terminal' }),
        );
        f.notifier.notifyReceiptChanged(receipt({ status: 'completed' }));
        f.notifier.onLifecycleApplied(
            signal({ phase: 'turnFinished', terminalId: 'other-terminal', agentTurnId: 'turn-1' }),
        );
        expect(f.writeCalls).toHaveLength(0);
    });

    it('logs a delivery-failed event, and never a delivered event, when the write is rejected', () => {
        const logger = { write: vi.fn() };
        const rejecting = new CommanderCompletionNotifier({
            database: {
                agentCommanderRows: () => ({
                    terminalId: COMMANDER_TERMINAL_ID,
                    sessionIds: ['session-1'],
                    projectId: 'commander-project',
                    sessionId: 'commander-session',
                }),
                getSession: () => session(),
            },
            hasIdleProof: () => true,
            inputEpoch: () => 0,
            logger: logger as never,
            write: () => false,
        });
        rejecting.onLifecycleApplied(signal({ phase: 'turnStarted' }));
        rejecting.notifyReceiptChanged(receipt({ status: 'completed' }));
        rejecting.onLifecycleApplied(signal({ phase: 'turnFinished', agentTurnId: 'turn-1' }));
        expect(logger.write).toHaveBeenCalledWith(
            'warn',
            expect.stringContaining('completion_notice_delivery_failed'),
            { fields: { reason: 'rejected' } },
        );
        expect(logger.write).not.toHaveBeenCalledWith(
            'info',
            expect.stringContaining('completion_notice_delivered'),
            expect.anything(),
        );
    });

    it('logs the gate holding a notice back once per change, then the delivery with its wait', () => {
        const logger = { write: vi.fn() };
        let epoch = 0;
        const notifier = new CommanderCompletionNotifier({
            database: {
                agentCommanderRows: () => ({
                    terminalId: COMMANDER_TERMINAL_ID,
                    sessionIds: ['session-1'],
                    projectId: 'commander-project',
                    sessionId: 'commander-session',
                }),
                getSession: () => session(),
            },
            hasIdleProof: () => true,
            inputEpoch: () => epoch,
            logger: logger as never,
            write: () => true,
        });
        notifier.onLifecycleApplied(signal({ phase: 'turnStarted' }));
        notifier.notifyReceiptChanged(receipt({ status: 'completed' }));
        notifier.notifyReceiptChanged(receipt({ status: 'failed', revision: 3 }));
        epoch = 1;
        notifier.onLifecycleApplied(signal({ phase: 'turnFinished', agentTurnId: 'turn-1' }));
        const fieldsOf = (event: string) =>
            logger.write.mock.calls
                .filter((call) => String(call[1]).endsWith(event))
                .map((call) => (call[2] as { fields: Record<string, unknown> }).fields);
        expect(fieldsOf('completion_notice_deferred').map((fields) => fields.reason)).toEqual([
            'commander_busy',
            'draft_input',
        ]);
        expect(fieldsOf('completion_notice_queued')[0]).toMatchObject({
            status: 'completed',
            pendingCount: 1,
        });

        epoch = 0;
        notifier.onLifecycleApplied(signal({ phase: 'turnStarted' }));
        notifier.onLifecycleApplied(signal({ phase: 'turnFinished', agentTurnId: 'turn-2' }));
        expect(fieldsOf('completion_notice_delivered')).toEqual([
            {
                count: 1,
                waitMs: fieldsOf('completion_notice_delivered')[0].waitMs,
                blockedTurns: 1,
            },
        ]);
    });

    /**
     * Pending notices exist only in Server Core memory. A shutdown that discards them has to say so, with how long the
     * batch waited and how many Commander turns could not take it, or the loss is invisible after the fact.
     */
    it('logs the batch a Server shutdown discards with the turns that could not take it', () => {
        const logger = { write: vi.fn() };
        let epoch = 0;
        const notifier = new CommanderCompletionNotifier({
            database: {
                agentCommanderRows: () => ({
                    terminalId: COMMANDER_TERMINAL_ID,
                    sessionIds: ['session-1'],
                    projectId: 'commander-project',
                    sessionId: 'commander-session',
                }),
                getSession: () => session(),
            },
            hasIdleProof: () => true,
            inputEpoch: () => epoch,
            logger: logger as never,
            write: () => true,
        });
        notifier.onLifecycleApplied(signal({ phase: 'turnStarted' }));
        notifier.notifyReceiptChanged(receipt({ status: 'completed' }));
        for (const turnId of ['turn-1', 'turn-2']) {
            notifier.onLifecycleApplied(signal({ phase: 'turnStarted' }));
            epoch += 1;
            notifier.onLifecycleApplied(signal({ phase: 'turnFinished', agentTurnId: turnId }));
        }

        notifier.close();
        notifier.close();

        const dropped = logger.write.mock.calls.filter((call) =>
            String(call[1]).endsWith('completion_notice_dropped'),
        );
        expect(dropped).toHaveLength(1);
        expect(dropped[0][2]).toEqual({
            fields: {
                reason: 'server_shutdown',
                count: 1,
                waitMs: expect.any(Number) as number,
                blockedTurns: 2,
                lastDeferral: 'draft_input',
            },
        });
    });
});
