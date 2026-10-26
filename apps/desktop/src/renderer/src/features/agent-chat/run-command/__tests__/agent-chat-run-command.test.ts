import type { BootstrapState, PaneLayout, TerminalRecord } from '@caxri/protocol';
import { createPaneLayout, openResource } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createTerminalForSession: vi.fn<(...parameters: unknown[]) => Promise<string | undefined>>(),
    getBootstrap: vi.fn<() => BootstrapState | undefined>(),
    getSessionState: vi.fn<() => { paneLayout: PaneLayout } | undefined>(),
    sendTerminalInput: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../../stores/selectors', () => ({
    getBootstrap: mocks.getBootstrap,
    getSessionState: mocks.getSessionState,
}));
vi.mock('../../../../stores/toasts', () => ({
    tryCommand: (_title: string, run: () => Promise<unknown>) => run(),
}));
vi.mock('../../../terminal/terminal-commands', () => ({
    createTerminalForSession: mocks.createTerminalForSession,
}));
vi.mock('../../../terminal/terminal-prompt-input', () => ({
    sendTerminalInputAtPrompt: mocks.sendTerminalInput,
}));

import {
    isRunnableShellFence,
    runAgentChatCode,
    shellInputForCode,
} from '../agent-chat-run-command';

function chatTerminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'chat-1',
        sessionId: 'session-1',
        kind: 'claude',
        surface: 'chat',
        cwd: '/repo',
        title: 'Chat',
        icon: 'terminal',
        orderIndex: 0,
        lastProcessState: 'running',
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

const nextId = () => crypto.randomUUID();

function layoutWith(...terminalIds: string[]): PaneLayout {
    const [first, ...rest] = terminalIds;
    let layout = createPaneLayout({ kind: 'terminal', terminalId: first }, nextId);
    for (const terminalId of rest)
        layout = openResource(layout, { kind: 'terminal', terminalId }, {}, nextId);
    return layout;
}

function paneOf(layout: PaneLayout): string {
    if (layout.root.type !== 'pane') throw new Error('expected a single pane');
    return layout.root.id;
}

describe('isRunnableShellFence', () => {
    it('accepts shell fence words in any case and rejects the rest', () => {
        for (const language of ['bash', 'sh', 'Shell', ' zsh ', 'shellscript'])
            expect(isRunnableShellFence(language)).toBe(true);
        for (const language of [undefined, '', 'console', 'fish', 'ts', 'powershell'])
            expect(isRunnableShellFence(language)).toBe(false);
    });
});

describe('shellInputForCode', () => {
    it('presses Return after every line and drops trailing blank lines', () => {
        expect(shellInputForCode('bun run start\n\n')).toBe('bun run start\r');
        expect(shellInputForCode('cd app\r\nbun test')).toBe('cd app\rbun test\r');
    });
});

describe('runAgentChatCode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.sendTerminalInput.mockResolvedValue(undefined);
    });

    it('splits a pane below the Chat in the Agent folder, then reuses that pane', async () => {
        mocks.getBootstrap.mockReturnValue({
            terminals: [chatTerminal({ id: 'chat-split', agentCwd: '/repo/.claude/worktrees/a' })],
        } as unknown as BootstrapState);
        const chatLayout = layoutWith('chat-split');
        mocks.getSessionState.mockReturnValue({ paneLayout: chatLayout });
        mocks.createTerminalForSession.mockResolvedValueOnce('run-1');

        await runAgentChatCode('chat-split', 'bun run db:migrate');

        expect(mocks.createTerminalForSession).toHaveBeenLastCalledWith('session-1', 'shell', {
            cwd: '/repo/.claude/worktrees/a',
            paneId: paneOf(chatLayout),
            split: 'down',
        });
        expect(mocks.sendTerminalInput).toHaveBeenLastCalledWith('run-1', 'bun run db:migrate\r');

        const runLayout = layoutWith('run-1');
        mocks.getSessionState.mockReturnValue({ paneLayout: runLayout });
        mocks.createTerminalForSession.mockResolvedValueOnce('run-2');

        await runAgentChatCode('chat-split', 'bun run start');

        expect(mocks.createTerminalForSession).toHaveBeenLastCalledWith('session-1', 'shell', {
            cwd: '/repo/.claude/worktrees/a',
            paneId: paneOf(runLayout),
        });
        expect(mocks.sendTerminalInput).toHaveBeenLastCalledWith('run-2', 'bun run start\r');
    });

    it('types nothing when the Terminal could not be created', async () => {
        mocks.getBootstrap.mockReturnValue({
            terminals: [chatTerminal({ id: 'chat-failed' })],
        } as unknown as BootstrapState);
        mocks.getSessionState.mockReturnValue(undefined);
        mocks.createTerminalForSession.mockResolvedValueOnce(undefined);

        await runAgentChatCode('chat-failed', 'ls');

        expect(mocks.createTerminalForSession).toHaveBeenCalledWith('session-1', 'shell', {
            cwd: '/repo',
        });
        expect(mocks.sendTerminalInput).not.toHaveBeenCalled();
    });
});
