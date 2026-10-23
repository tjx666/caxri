import type { BootstrapState, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    readAgentChatSnapshot: vi.fn<(terminalId: string) => Promise<{ activeTurnId?: string }>>(),
    showConfirm: vi.fn<(...parameters: unknown[]) => Promise<boolean>>(() =>
        Promise.resolve(false),
    ),
    tryCommand: vi.fn(async (...[, run]: [string, () => Promise<unknown>]): Promise<unknown> => {
        try {
            return await run();
        } catch {
            return undefined;
        }
    }),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { window: { showConfirm: mocks.showConfirm } } }));
vi.mock('../../../stores/selectors', () => ({ getBootstrap: mocks.getBootstrap }));
vi.mock('../../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));
vi.mock('../../agent-chat/agent-chat-client', () => ({
    readAgentChatSnapshot: mocks.readAgentChatSnapshot,
}));

import { confirmBeforeEndingTurn, isAgentTurnRunning } from '../agent-turn-guard';

function agentTerminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'claude',
        provider: 'claude',
        agentSessionId: 'claude-session-1',
        lastProcessState: 'running',
        lastAgentProcessState: 'running',
        ...overrides,
    } as TerminalRecord;
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: 'session-1',
        primaryAgentTerminalId: 'terminal-1',
        lastActivityState: 'running',
        ...overrides,
    } as SessionRecord;
}

function bootstrapWith(terminal: TerminalRecord, sessionRecord: SessionRecord): BootstrapState {
    return { terminals: [terminal], sessions: [sessionRecord] } as unknown as BootstrapState;
}

const COPY = {
    confirmLabel: 'Stop and Restart',
    failureTitle: 'Restart Agent failed',
    outcome: 'Restarting stops the current turn and resumes the same conversation.',
};

beforeEach(() => {
    mocks.showConfirm.mockClear();
    mocks.getBootstrap.mockReset();
    mocks.readAgentChatSnapshot.mockReset();
});

describe('isAgentTurnRunning', () => {
    it.each(['running', 'waiting'] as const)(
        'reads a %s Primary Agent with a live process as mid-turn',
        (lastActivityState) => {
            expect(isAgentTurnRunning(agentTerminal(), session({ lastActivityState }))).toBe(true);
        },
    );

    it.each([
        {
            name: 'an idle Session',
            terminal: agentTerminal(),
            state: session({ lastActivityState: 'completed' }),
        },
        {
            name: 'a secondary Agent',
            terminal: agentTerminal(),
            state: session({ primaryAgentTerminalId: 'terminal-2' }),
        },
        {
            name: 'a PTY Agent whose process exited',
            terminal: agentTerminal({ lastAgentProcessState: 'stopped' }),
            state: session(),
        },
        { name: 'a missing Session', terminal: agentTerminal(), state: undefined },
    ])('does not read $name as mid-turn', ({ terminal, state }) => {
        expect(isAgentTurnRunning(terminal, state)).toBe(false);
    });

    it("reads a secondary Chat from its own snapshot, not the Primary Agent's activity", () => {
        const chat = agentTerminal({ id: 'terminal-2', surface: 'chat' });
        const idleSession = session({ lastActivityState: 'idle' });
        expect(isAgentTurnRunning(chat, idleSession, { activeTurnId: 'turn-1' })).toBe(true);
        expect(isAgentTurnRunning(chat, session(), {})).toBe(false);
        expect(isAgentTurnRunning(chat, session())).toBe(false);
    });

    it('keeps a secondary PTY Agent idle even with a snapshot', () => {
        const pty = agentTerminal({ id: 'terminal-2' });
        expect(isAgentTurnRunning(pty, session(), { activeTurnId: 'turn-1' })).toBe(false);
    });

    it('trusts Session Activity alone for a Chat, which has no PTY process', () => {
        expect(
            isAgentTurnRunning(
                agentTerminal({ surface: 'chat', lastAgentProcessState: undefined }),
                session(),
            ),
        ).toBe(true);
    });
});

describe('confirmBeforeEndingTurn', () => {
    it('proceeds in the same tick without asking when no turn is running', () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(agentTerminal(), session({ lastActivityState: 'idle' })),
        );
        const proceed = vi.fn();
        void confirmBeforeEndingTurn('terminal-1', COPY, proceed);
        expect(proceed).toHaveBeenCalledOnce();
        expect(mocks.showConfirm).not.toHaveBeenCalled();
    });

    it('proceeds without asking for a Shell Terminal', () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(
                agentTerminal({ kind: 'shell', provider: undefined }),
                session({ primaryAgentTerminalId: undefined }),
            ),
        );
        const proceed = vi.fn();
        void confirmBeforeEndingTurn('terminal-1', COPY, proceed);
        expect(proceed).toHaveBeenCalledOnce();
    });

    it('asks before stopping a running turn and proceeds only after confirmation', async () => {
        mocks.getBootstrap.mockReturnValue(bootstrapWith(agentTerminal(), session()));
        mocks.showConfirm.mockResolvedValueOnce(true);
        const proceed = vi.fn();
        await confirmBeforeEndingTurn('terminal-1', COPY, proceed);
        expect(mocks.showConfirm).toHaveBeenCalledWith({
            title: 'Stop the running turn?',
            message:
                'Claude is still working. Restarting stops the current turn and resumes the same conversation.',
            confirmLabel: 'Stop and Restart',
        });
        expect(proceed).toHaveBeenCalledOnce();
    });

    it('leaves the running turn alone when the user cancels', async () => {
        mocks.getBootstrap.mockReturnValue(bootstrapWith(agentTerminal(), session()));
        const proceed = vi.fn();
        await confirmBeforeEndingTurn('terminal-1', COPY, proceed);
        expect(mocks.showConfirm).toHaveBeenCalledOnce();
        expect(proceed).not.toHaveBeenCalled();
    });

    it('asks before stopping a running turn in a second Chat of the same Session', async () => {
        const chat = agentTerminal({ id: 'terminal-2', surface: 'chat' });
        mocks.getBootstrap.mockReturnValue({
            terminals: [agentTerminal(), chat],
            sessions: [session({ lastActivityState: 'idle' })],
        } as unknown as BootstrapState);
        mocks.readAgentChatSnapshot.mockResolvedValue({ activeTurnId: 'turn-1' });
        const proceed = vi.fn();
        await confirmBeforeEndingTurn('terminal-2', COPY, proceed);
        expect(mocks.readAgentChatSnapshot).toHaveBeenCalledWith('terminal-2');
        expect(mocks.showConfirm).toHaveBeenCalledOnce();
        expect(proceed).not.toHaveBeenCalled();
    });

    it('proceeds without asking for an idle second Chat', async () => {
        const chat = agentTerminal({ id: 'terminal-2', surface: 'chat' });
        mocks.getBootstrap.mockReturnValue({
            terminals: [agentTerminal(), chat],
            sessions: [session()],
        } as unknown as BootstrapState);
        mocks.readAgentChatSnapshot.mockResolvedValue({});
        const proceed = vi.fn();
        await confirmBeforeEndingTurn('terminal-2', COPY, proceed);
        expect(mocks.showConfirm).not.toHaveBeenCalled();
        expect(proceed).toHaveBeenCalledOnce();
    });
});
