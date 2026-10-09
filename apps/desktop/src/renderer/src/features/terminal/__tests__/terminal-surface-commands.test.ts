import type { TerminalKind, TerminalRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn<(...parameters: unknown[]) => Promise<unknown>>(() =>
        Promise.resolve({ status: 'switched' }),
    ),
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

vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.caxriRequest, window: { showConfirm: mocks.showConfirm } },
}));
vi.mock('../../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));
vi.mock('../../../stores/workbench', () => ({ refreshWorkbench: vi.fn() }));

import { switchTerminalSurface, terminalSurfaceMenuEntry } from '../terminal-surface-commands';

function agentTerminal(
    kind: TerminalKind,
    overrides: Partial<TerminalRecord> = {},
): TerminalRecord {
    return {
        id: 'terminal-1',
        kind,
        ...(kind !== 'shell' && { provider: kind }),
        agentSessionId: 'thread-1',
        ...overrides,
    } as TerminalRecord;
}

beforeEach(() => {
    mocks.caxriRequest.mockClear();
    mocks.showConfirm.mockClear();
});

describe('terminalSurfaceMenuEntry', () => {
    it('offers the other surface for a Chat-capable Agent', () => {
        expect(terminalSurfaceMenuEntry(agentTerminal('codex'))).toMatchObject({
            label: 'Open as Chat',
            disabled: false,
        });
        expect(
            terminalSurfaceMenuEntry(agentTerminal('claude', { surface: 'chat' })),
        ).toMatchObject({ label: 'Open as Terminal', disabled: false });
    });

    it('explains why an unbound Agent cannot switch yet', () => {
        expect(
            terminalSurfaceMenuEntry(agentTerminal('codex', { agentSessionId: undefined })),
        ).toMatchObject({
            disabled: true,
            disabledReason: 'Send a message first; there is no conversation to continue yet',
        });
    });

    it('has no entry for a Shell or an Agent without Chat', () => {
        expect(terminalSurfaceMenuEntry(agentTerminal('shell'))).toBeUndefined();
        expect(terminalSurfaceMenuEntry(agentTerminal('grok'))).toBeUndefined();
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
