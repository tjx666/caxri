import type { TerminalKind, TerminalRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn<(...parameters: unknown[]) => Promise<unknown>>(() =>
        Promise.resolve({ status: 'switched' }),
    ),
    showConfirm: vi.fn<(...parameters: unknown[]) => Promise<boolean>>(() =>
        Promise.resolve(false),
    ),
    pushToast: vi.fn(),
    refreshWorkbench: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    shortcut: 'cmd+shift+j' as string | undefined,
    writeText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()),
    tryCommand: vi.fn(
        async (
            ...[, run, options]: [
                string,
                () => Promise<unknown>,
                { refresh?: () => Promise<void> }?,
            ]
        ): Promise<unknown> => {
            try {
                const result = await run();
                await options?.refresh?.();
                return result;
            } catch {
                return undefined;
            }
        },
    ),
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.caxriRequest, window: { showConfirm: mocks.showConfirm } },
}));
vi.mock('../../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: mocks.tryCommand,
}));
vi.mock('../../../lib/keybindings', () => ({ readCommandShortcut: () => mocks.shortcut }));
vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } });
vi.mock('../../../stores/workbench', () => ({ refreshWorkbench: mocks.refreshWorkbench }));

import {
    agentResumeCommandMenuEntry,
    isAgentConversationResumable,
    switchTerminalSurface,
    switchTerminalSurfaceTo,
    terminalSurfaceMenuEntry,
} from '../terminal-surface-commands';
import { TerminalSurfaceSwitchRegistry } from '../terminal-surface-switch-pending';

function agentTerminal(
    kind: TerminalKind,
    overrides: Partial<TerminalRecord> = {},
): TerminalRecord {
    return {
        id: 'terminal-1',
        kind,
        ...(kind !== 'shell' && { provider: kind }),
        agentSessionId: 'thread-1',
        cwd: '/work/app',
        ...overrides,
    } as TerminalRecord;
}

beforeEach(() => {
    mocks.caxriRequest.mockClear();
    mocks.refreshWorkbench.mockClear();
    mocks.showConfirm.mockClear();
    mocks.writeText.mockClear();
    mocks.pushToast.mockClear();
});

describe('terminalSurfaceMenuEntry', () => {
    it('offers the other surface for a Chat-capable Agent', () => {
        expect(terminalSurfaceMenuEntry(agentTerminal('codex'))).toMatchObject({
            label: 'Open as Chat',
            shortcut: 'cmd+shift+j',
        });
        expect(
            terminalSurfaceMenuEntry(agentTerminal('claude', { surface: 'chat' })),
        ).toMatchObject({ label: 'Open as Terminal' });
    });

    it('lets an Agent with no conversation yet switch too', () => {
        const entry = terminalSurfaceMenuEntry(
            agentTerminal('codex', { agentSessionId: undefined }),
        );
        expect(entry).toMatchObject({ label: 'Open as Chat' });
        expect(entry).not.toHaveProperty('disabled', true);
    });

    it('has no entry for a Shell', () => {
        expect(terminalSurfaceMenuEntry(agentTerminal('shell'))).toBeUndefined();
    });

    it('drops the key hint for a menu whose target is not the active Terminal', () => {
        const entry = terminalSurfaceMenuEntry(agentTerminal('codex'), false);
        expect(entry).toMatchObject({ label: 'Open as Chat' });
        expect(entry).not.toHaveProperty('shortcut', 'cmd+shift+j');
    });
});

describe('switchTerminalSurface', () => {
    it('switches without asking when no turn is running', async () => {
        await switchTerminalSurface('terminal-1', 'chat', 'Codex');
        expect(mocks.caxriRequest).toHaveBeenCalledExactlyOnceWith('terminal.switchSurface', {
            terminalId: 'terminal-1',
            surface: 'chat',
        });
        expect(mocks.showConfirm).not.toHaveBeenCalled();
    });

    it('interrupts a running turn only after the user confirms', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ status: 'turnRunning' });
        mocks.showConfirm.mockResolvedValueOnce(true);
        await switchTerminalSurface('terminal-1', 'pty', 'Codex');
        expect(mocks.showConfirm).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Stop the running turn?',
                message:
                    'Codex is still working. Switching stops the current turn and continues the conversation in the Terminal.',
            }),
        );
        expect(mocks.caxriRequest).toHaveBeenLastCalledWith('terminal.switchSurface', {
            terminalId: 'terminal-1',
            surface: 'pty',
            interruptTurn: true,
        });
    });

    it('leaves the running turn alone when the user cancels', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ status: 'turnRunning' });
        await switchTerminalSurface('terminal-1', 'chat', 'Codex');
        expect(mocks.caxriRequest).toHaveBeenCalledTimes(1);
    });
});

describe('switchTerminalSurfaceTo', () => {
    it('switches only toward the surface the Agent is not on', async () => {
        await switchTerminalSurfaceTo(agentTerminal('codex'), 'pty');
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
        await switchTerminalSurfaceTo(agentTerminal('codex'), 'chat');
        expect(mocks.caxriRequest).toHaveBeenCalledExactlyOnceWith('terminal.switchSurface', {
            terminalId: 'terminal-1',
            surface: 'chat',
        });
    });

    it('leaves a Terminal without a Chat surface alone', () => {
        expect(switchTerminalSurfaceTo(agentTerminal('shell'), 'chat')).toBeUndefined();
    });
});

describe('agentResumeCommandMenuEntry', () => {
    it("copies the command that continues the Agent's conversation in its own TUI", async () => {
        const entry = agentResumeCommandMenuEntry(agentTerminal('codex'), true);
        expect(entry).toMatchObject({ label: 'Copy Resume Command', disabled: false });
        if (entry.type === 'separator' || entry.type === 'submenu') throw new Error('item');
        await entry.onSelect();
        expect(mocks.writeText).toHaveBeenCalledWith('cd /work/app && codex resume thread-1');
        expect(mocks.pushToast).toHaveBeenCalledWith('success', 'Resume command copied');
    });

    it('is disabled until there is a conversation, with the caller wording', () => {
        expect(
            agentResumeCommandMenuEntry(
                agentTerminal('claude', { agentSessionId: undefined }),
                true,
                'No conversation yet',
            ),
        ).toMatchObject({ disabled: true, disabledReason: 'No conversation yet' });
        expect(agentResumeCommandMenuEntry(undefined, true)).toMatchObject({ disabled: true });
    });

    it('is disabled for a bound Agent Session whose conversation is not resumable yet', () => {
        expect(agentResumeCommandMenuEntry(agentTerminal('claude'), false)).toMatchObject({
            disabled: true,
            disabledReason: 'Send a message first; there is no conversation to resume yet',
        });
    });
});

describe('isAgentConversationResumable', () => {
    it('is false for a bound Claude Code session whose transcript has not been written', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ path: '/t.jsonl', exists: false });
        await expect(isAgentConversationResumable(agentTerminal('claude'))).resolves.toBe(false);
        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.agentTranscript', {
            terminalId: 'terminal-1',
            withContent: false,
        });
    });

    it('is true once the transcript exists, or when the provider keeps none on disk', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ path: '/t.jsonl', exists: true });
        await expect(isAgentConversationResumable(agentTerminal('claude'))).resolves.toBe(true);
        mocks.caxriRequest.mockResolvedValueOnce(null);
        await expect(isAgentConversationResumable(agentTerminal('grok'))).resolves.toBe(true);
    });

    it('falls back to the binding when the read fails, and is false without one', async () => {
        mocks.caxriRequest.mockRejectedValueOnce(new Error('offline'));
        await expect(isAgentConversationResumable(agentTerminal('codex'))).resolves.toBe(true);
        mocks.caxriRequest.mockClear();
        await expect(
            isAgentConversationResumable(agentTerminal('claude', { agentSessionId: undefined })),
        ).resolves.toBe(false);
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });
});

describe('switchTerminalSurfaceTo re-entry', () => {
    it('ignores a second switch for the same Terminal while the first is pending', async () => {
        const switches = new TerminalSurfaceSwitchRegistry();
        const firstReply = Promise.withResolvers<unknown>();
        mocks.caxriRequest.mockImplementationOnce(() => firstReply.promise);
        const first = switchTerminalSurfaceTo(agentTerminal('codex'), 'chat', switches);
        expect(switches.pendingSurface('terminal-1')).toBe('chat');
        expect(switchTerminalSurfaceTo(agentTerminal('codex'), 'chat', switches)).toBeUndefined();
        expect(mocks.caxriRequest).toHaveBeenCalledTimes(1);

        firstReply.resolve({ status: 'switched' });
        await first;
        expect(switches.pendingSurface('terminal-1')).toBeUndefined();
        await switchTerminalSurfaceTo(agentTerminal('codex'), 'chat', switches);
        expect(mocks.caxriRequest).toHaveBeenCalledTimes(2);
    });

    it('stays pending until the Workbench refreshed, so a quick second press switches back', async () => {
        const switches = new TerminalSurfaceSwitchRegistry();
        const refreshed = Promise.withResolvers<undefined>();
        mocks.refreshWorkbench.mockReturnValueOnce(refreshed.promise);
        const first = switchTerminalSurfaceTo(agentTerminal('codex'), 'chat', switches);
        await vi.waitFor(() => expect(mocks.refreshWorkbench).toHaveBeenCalledTimes(1));
        // The bootstrap still says PTY here, so a press now would aim at Chat again: it must not run.
        expect(switchTerminalSurfaceTo(agentTerminal('codex'), 'chat', switches)).toBeUndefined();
        expect(switches.pendingSurface('terminal-1')).toBe('chat');

        refreshed.resolve(undefined);
        await first;
        expect(switches.pendingSurface('terminal-1')).toBeUndefined();
        await switchTerminalSurfaceTo(agentTerminal('codex', { surface: 'chat' }), 'pty', switches);
        expect(mocks.caxriRequest).toHaveBeenLastCalledWith('terminal.switchSurface', {
            terminalId: 'terminal-1',
            surface: 'pty',
        });
    });
});
