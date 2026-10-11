import type { BootstrapState, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    restartTerminalWithRecovery: vi.fn<(terminalId: string, failureTitle?: string) => void>(),
    showConfirm: vi.fn<(...parameters: unknown[]) => Promise<boolean>>(() =>
        Promise.resolve(false),
    ),
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    readAgentChatSnapshot: vi.fn<(terminalId: string) => Promise<{ activeTurnId?: string }>>(),
    tryCommand: vi.fn(async (...[, run]: [string, () => Promise<unknown>]): Promise<unknown> => {
        try {
            return await run();
        } catch {
            return undefined;
        }
    }),
}));

vi.mock('../terminal-commands', () => ({
    restartTerminalWithRecovery: mocks.restartTerminalWithRecovery,
}));
vi.mock('../../agent-chat/agent-chat-client', () => ({
    readAgentChatSnapshot: mocks.readAgentChatSnapshot,
}));
vi.mock('../../../lib/caxri', () => ({ caxri: { window: { showConfirm: mocks.showConfirm } } }));
vi.mock('../../../stores/selectors', () => ({ getBootstrap: mocks.getBootstrap }));
vi.mock('../../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));
vi.mock('../../../lib/keybindings', () => ({ readCommandShortcut: () => {} }));
vi.mock('../../../stores/workbench', () => ({ refreshWorkbench: vi.fn() }));
vi.mock('../../session/session-commands', () => ({ moveTerminalToNewSession: vi.fn() }));

import { serializeContextMenu } from '../../../lib/context-menu';
import { agentReloadMenuEntry, isAgentTurnRunning, reloadAgent } from '../terminal-reload-commands';
import { terminalTabMenuEntries } from '../terminal-tab-menu';

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

beforeEach(() => {
    mocks.restartTerminalWithRecovery.mockClear();
    mocks.showConfirm.mockClear();
    mocks.getBootstrap.mockReset();
    mocks.readAgentChatSnapshot.mockReset();
});

describe('agentReloadMenuEntry', () => {
    it('reloads the clicked Agent Terminal without asking when no turn is running', async () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(agentTerminal(), session({ lastActivityState: 'idle' })),
        );
        const entry = agentReloadMenuEntry(agentTerminal());
        expect(entry).toMatchObject({ label: 'Reload Agent', disabled: false });
        if (entry.type === 'separator' || entry.type === 'submenu') throw new Error('not an item');
        entry.onSelect();
        await vi.waitFor(() =>
            expect(mocks.restartTerminalWithRecovery).toHaveBeenCalledWith(
                'terminal-1',
                'Reload Agent failed',
            ),
        );
        expect(mocks.showConfirm).not.toHaveBeenCalled();
    });

    it('still reloads an Agent whose process already exited', () => {
        expect(agentReloadMenuEntry(agentTerminal({ lastProcessState: 'stopped' }))).toMatchObject({
            disabled: false,
        });
    });

    it.each([
        {
            terminal: undefined,
            reason: 'This Session has no Agent Terminal',
        },
        {
            terminal: agentTerminal({ agentSessionId: undefined }),
            reason: 'Send a message first; there is no conversation to reload yet',
        },
        {
            terminal: agentTerminal({ lastProcessState: 'detached' }),
            reason: 'Resume the detached Agent first',
        },
    ])('explains why it cannot reload: $reason', ({ terminal, reason }) => {
        expect(agentReloadMenuEntry(terminal)).toMatchObject({
            disabled: true,
            disabledReason: reason,
        });
    });

    it("reuses the caller's sentence for a missing Agent or conversation, not for a detached one", () => {
        const reason = 'This Session has no Agent conversation yet';
        expect(agentReloadMenuEntry(undefined, reason)).toMatchObject({ disabledReason: reason });
        expect(
            agentReloadMenuEntry(agentTerminal({ agentSessionId: undefined }), reason),
        ).toMatchObject({ disabledReason: reason });
        expect(
            agentReloadMenuEntry(agentTerminal({ lastProcessState: 'detached' }), reason),
        ).toMatchObject({ disabledReason: 'Resume the detached Agent first' });
    });
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

describe('reloadAgent', () => {
    it('asks before stopping a running turn and reloads only after confirmation', async () => {
        mocks.getBootstrap.mockReturnValue(bootstrapWith(agentTerminal(), session()));
        mocks.showConfirm.mockResolvedValueOnce(true);
        await reloadAgent(agentTerminal());
        expect(mocks.showConfirm).toHaveBeenCalledWith({
            title: 'Stop the running turn?',
            message:
                'Claude is still working. Reloading stops the current turn and resumes the same conversation.',
            confirmLabel: 'Stop and Reload',
        });
        expect(mocks.restartTerminalWithRecovery).toHaveBeenCalledWith(
            'terminal-1',
            'Reload Agent failed',
        );
    });

    it('leaves the running turn alone when the user cancels', async () => {
        mocks.getBootstrap.mockReturnValue(bootstrapWith(agentTerminal(), session()));
        await reloadAgent(agentTerminal());
        expect(mocks.showConfirm).toHaveBeenCalledTimes(1);
        expect(mocks.restartTerminalWithRecovery).not.toHaveBeenCalled();
    });

    it('asks before stopping a running turn in a second Chat of the same Session', async () => {
        const chat = agentTerminal({ id: 'terminal-2', surface: 'chat' });
        mocks.getBootstrap.mockReturnValue({
            terminals: [agentTerminal(), chat],
            sessions: [session({ lastActivityState: 'idle' })],
        } as unknown as BootstrapState);
        mocks.readAgentChatSnapshot.mockResolvedValue({ activeTurnId: 'turn-1' });

        await reloadAgent(chat);

        expect(mocks.readAgentChatSnapshot).toHaveBeenCalledWith('terminal-2');
        expect(mocks.showConfirm).toHaveBeenCalledOnce();
        expect(mocks.restartTerminalWithRecovery).not.toHaveBeenCalled();
    });

    it('reloads an idle second Chat without asking', async () => {
        const chat = agentTerminal({ id: 'terminal-2', surface: 'chat' });
        mocks.getBootstrap.mockReturnValue({
            terminals: [agentTerminal(), chat],
            sessions: [session()],
        } as unknown as BootstrapState);
        mocks.readAgentChatSnapshot.mockResolvedValue({});

        await reloadAgent(chat);

        expect(mocks.showConfirm).not.toHaveBeenCalled();
        expect(mocks.restartTerminalWithRecovery).toHaveBeenCalledWith(
            'terminal-2',
            'Reload Agent failed',
        );
    });

    it('reads the latest state, not the snapshot the menu was built from', async () => {
        mocks.getBootstrap.mockReturnValue(
            bootstrapWith(agentTerminal(), session({ lastActivityState: 'completed' })),
        );
        await reloadAgent(agentTerminal());
        expect(mocks.showConfirm).not.toHaveBeenCalled();
        expect(mocks.restartTerminalWithRecovery).toHaveBeenCalledTimes(1);
    });
});

describe('terminalTabMenuEntries', () => {
    function labels(terminal: TerminalRecord): Array<string | undefined> {
        return serializeContextMenu(terminalTabMenuEntries(terminal, false)).items.map((item) =>
            item.type === 'separator' ? undefined : item.label,
        );
    }

    it('groups the Agent actions, the move, and the copy with separators', () => {
        expect(labels(agentTerminal({ kind: 'codex', provider: 'codex' }))).toEqual([
            'Open as Chat',
            'Reload Agent',
            undefined,
            'Move to New Session',
            undefined,
            'Copy Resume Command',
        ]);
    });

    it('leaves a Shell tab only its move, with no stray separators', () => {
        expect(
            labels(
                agentTerminal({ kind: 'shell', provider: undefined, agentSessionId: undefined }),
            ),
        ).toEqual(['Move to New Session']);
    });
});
