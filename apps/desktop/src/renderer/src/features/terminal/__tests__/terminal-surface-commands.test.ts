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
    shortcut: 'cmd+shift+j' as string | undefined,
    writeText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()),
    tryCommand: vi.fn(async (...[, run]: [string, () => Promise<unknown>]): Promise<unknown> => {
        try {
            return await run();
        } catch {
            return undefined;
        }
    }),
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
vi.mock('../../../stores/workbench', () => ({ refreshWorkbench: vi.fn() }));

import {
    agentResumeCommandMenuEntry,
    switchTerminalSurface,
    switchTerminalSurfaceTo,
    terminalSurfaceMenuEntry,
} from '../terminal-surface-commands';

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
        expect(switchTerminalSurfaceTo(agentTerminal('grok'), 'chat')).toBeUndefined();
        expect(switchTerminalSurfaceTo(agentTerminal('shell'), 'chat')).toBeUndefined();
    });
});

describe('agentResumeCommandMenuEntry', () => {
    it("copies the command that continues the Agent's conversation in its own TUI", async () => {
        const entry = agentResumeCommandMenuEntry(agentTerminal('codex'));
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
                'No conversation yet',
            ),
        ).toMatchObject({ disabled: true, disabledReason: 'No conversation yet' });
        expect(agentResumeCommandMenuEntry(undefined)).toMatchObject({ disabled: true });
    });
});
