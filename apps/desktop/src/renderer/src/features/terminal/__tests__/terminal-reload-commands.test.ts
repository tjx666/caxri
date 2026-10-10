import type { TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ restartTerminal: vi.fn<(terminalId: string) => void>() }));

vi.mock('../terminal-commands', () => ({ restartTerminal: mocks.restartTerminal }));

import { agentReloadMenuEntry } from '../terminal-reload-commands';
import { terminalTabMenuEntries } from '../terminal-tab-menu';

function agentTerminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
    return {
        id: 'terminal-1',
        kind: 'claude',
        provider: 'claude',
        agentSessionId: 'claude-session-1',
        lastProcessState: 'running',
        ...overrides,
    } as TerminalRecord;
}

describe('agentReloadMenuEntry', () => {
    it('resumes the clicked Agent Terminal through the Terminal restart', () => {
        const entry = agentReloadMenuEntry(agentTerminal());
        expect(entry).toMatchObject({ label: 'Reload Agent', disabled: false });
        if (entry.type === 'separator' || entry.type === 'submenu') throw new Error('not an item');
        entry.onSelect();
        expect(mocks.restartTerminal).toHaveBeenCalledWith('terminal-1');
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
});

describe('terminalTabMenuEntries', () => {
    it('offers Reload Agent on an Agent tab only', () => {
        const labels = (terminal: TerminalRecord) =>
            terminalTabMenuEntries(terminal, false).flatMap((entry) =>
                entry && entry.type !== 'separator' ? [entry.label] : [],
            );
        expect(labels(agentTerminal())).toContain('Reload Agent');
        expect(
            labels(
                agentTerminal({ kind: 'shell', provider: undefined, agentSessionId: undefined }),
            ),
        ).not.toContain('Reload Agent');
    });
});
