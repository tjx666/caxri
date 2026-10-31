import type { BootstrapState, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    activateTerminal: vi.fn(),
    focusTerminalById: vi.fn(),
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    getSelectedSession: vi.fn<() => SessionRecord | undefined>(),
    getSessionState: vi.fn(() => {}),
    request: vi.fn(() => Promise.resolve(null)),
    whenTerminalAttached: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSelectedSession: mocks.getSelectedSession,
    getSessionState: mocks.getSessionState,
}));
vi.mock('../terminal-commands', () => ({ activateTerminal: mocks.activateTerminal }));
vi.mock('../terminal-pane-handlers', () => ({
    focusTerminalById: mocks.focusTerminalById,
    whenTerminalAttached: mocks.whenTerminalAttached,
}));

const { chooseAgentPromptTerminal, MAX_AGENT_PROMPT_LENGTH, sendPromptToSessionAgent } =
    await import('../agent-prompt-commands');

function terminal(overrides: Partial<TerminalRecord> & Pick<TerminalRecord, 'id'>): TerminalRecord {
    return { sessionId: 'session-1', createdAt: 1, orderIndex: 0, ...overrides } as TerminalRecord;
}

const shell = terminal({ id: 'shell', createdAt: 9 });
const exitedAgent = terminal({
    id: 'exited',
    createdAt: 8,
    provider: 'claude',
    lastAgentProcessState: 'stopped',
});
const ptyAgent = terminal({
    id: 'pty',
    createdAt: 2,
    provider: 'codex',
    lastAgentProcessState: 'running',
});
const chatAgent = terminal({ id: 'chat', createdAt: 3, provider: 'claude', surface: 'chat' });
const otherSession = terminal({
    id: 'other',
    sessionId: 'session-2',
    createdAt: 10,
    provider: 'claude',
    surface: 'chat',
});

describe('chooseAgentPromptTerminal', () => {
    it("picks the Session's newest Chat or running Agent, never a shell, an exited Agent, or another Session's", () => {
        const all = [shell, exitedAgent, ptyAgent, chatAgent, otherSession];
        expect(chooseAgentPromptTerminal(all, 'session-1', undefined)?.id).toBe('chat');
        expect(
            chooseAgentPromptTerminal([shell, exitedAgent, ptyAgent], 'session-1', undefined)?.id,
        ).toBe('pty');
        expect(chooseAgentPromptTerminal([shell, exitedAgent], 'session-1', undefined)).toBe(
            undefined,
        );
    });
});

describe('sendPromptToSessionAgent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSelectedSession.mockReturnValue({ id: 'session-1' } as SessionRecord);
        mocks.whenTerminalAttached.mockResolvedValue(true);
    });

    it('sends a Chat the prompt as a message and reveals it', async () => {
        mocks.getBootstrap.mockReturnValue({ terminals: [chatAgent] } as BootstrapState);

        await expect(sendPromptToSessionAgent('Fix it')).resolves.toBe('Claude');

        expect(mocks.request).toHaveBeenCalledWith('agentChat.send', {
            terminalId: 'chat',
            text: 'Fix it',
        });
        expect(mocks.activateTerminal).toHaveBeenCalledWith('chat');
        expect(mocks.whenTerminalAttached).not.toHaveBeenCalled();
    });

    it('reveals a Terminal Agent, waits for its pane, then submits one bracketed paste', async () => {
        mocks.getBootstrap.mockReturnValue({ terminals: [ptyAgent] } as BootstrapState);

        await expect(sendPromptToSessionAgent('Fix\nit')).resolves.toBe('Codex');

        expect(mocks.activateTerminal.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.request.mock.invocationCallOrder[0],
        );
        expect(mocks.request).toHaveBeenCalledWith('terminal.input', {
            terminalId: 'pty',
            data: '\u{1B}[200~Fix\rit\u{1B}[201~\r',
            requireRunningAgent: true,
        });
        expect(mocks.focusTerminalById).toHaveBeenCalledWith('pty');
    });

    it('writes nothing when the Terminal Agent never attaches', async () => {
        mocks.getBootstrap.mockReturnValue({ terminals: [ptyAgent] } as BootstrapState);
        mocks.whenTerminalAttached.mockResolvedValue(false);

        await expect(sendPromptToSessionAgent('Fix it')).rejects.toThrow(
            'Codex is not ready for input',
        );
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('refuses without an Agent in the Session or with an oversized prompt', async () => {
        mocks.getBootstrap.mockReturnValue({ terminals: [shell, otherSession] } as BootstrapState);

        await expect(sendPromptToSessionAgent('Fix it')).rejects.toThrow(
            'Start an Agent in this Session first',
        );
        await expect(
            sendPromptToSessionAgent('x'.repeat(MAX_AGENT_PROMPT_LENGTH + 1)),
        ).rejects.toThrow('too long');
        expect(mocks.request).not.toHaveBeenCalled();
    });
});
