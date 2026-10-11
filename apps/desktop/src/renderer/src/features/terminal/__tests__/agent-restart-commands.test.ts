import type { TerminalRecord } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    restartTerminal: vi.fn<(terminalId: string) => void>(),
}));

vi.mock('../terminal-commands', () => ({ restartTerminal: mocks.restartTerminal }));
vi.mock('../../../lib/caxri', () => ({
    caxri: { request: () => Promise.resolve({ path: '/t.jsonl', exists: true }) },
}));
vi.mock('../../../stores/selectors', () => ({ getBootstrap: vi.fn() }));
vi.mock('../../../stores/toasts', () => ({ tryCommand: vi.fn(), pushToast: vi.fn() }));
vi.mock('../../../lib/keybindings', () => ({
    readCommandShortcut: (id: string) => (id === 'terminal.restart' ? 'cmd+shift+r' : undefined),
}));
vi.mock('../../../stores/workbench', () => ({ refreshWorkbench: vi.fn() }));
vi.mock('../../session/session-commands', () => ({ moveTerminalToNewSession: vi.fn() }));

import { serializeContextMenu } from '../../../lib/context-menu';
import { agentRestartMenuEntry } from '../agent-restart-commands';
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

beforeEach(() => {
    mocks.restartTerminal.mockClear();
});

describe('agentRestartMenuEntry', () => {
    it('restarts the clicked Agent Terminal through the guarded terminal.restart path, with its key hint', () => {
        const entry = agentRestartMenuEntry(agentTerminal());
        expect(entry).toMatchObject({
            label: 'Restart Agent',
            disabled: false,
            shortcut: 'cmd+shift+r',
        });
        if (entry.type === 'separator' || entry.type === 'submenu') throw new Error('not an item');
        entry.onSelect();
        expect(mocks.restartTerminal).toHaveBeenCalledWith('terminal-1');
    });

    it('still restarts an Agent whose process already exited', () => {
        expect(agentRestartMenuEntry(agentTerminal({ lastProcessState: 'stopped' }))).toMatchObject(
            {
                disabled: false,
            },
        );
    });

    it.each([
        {
            terminal: undefined,
            reason: 'This Session has no Agent Terminal',
        },
        {
            terminal: agentTerminal({ agentSessionId: undefined }),
            reason: 'Send a message first; there is no conversation to resume yet',
        },
        {
            terminal: agentTerminal({ lastProcessState: 'detached' }),
            reason: 'Resume the detached Agent first',
        },
    ])('explains why it cannot restart: $reason', ({ terminal, reason }) => {
        expect(agentRestartMenuEntry(terminal)).toMatchObject({
            disabled: true,
            disabledReason: reason,
        });
    });

    it("reuses the caller's sentence for a missing Agent or conversation, not for a detached one", () => {
        const reason = 'This Session has no Agent conversation yet';
        expect(agentRestartMenuEntry(undefined, reason)).toMatchObject({ disabledReason: reason });
        expect(
            agentRestartMenuEntry(agentTerminal({ agentSessionId: undefined }), reason),
        ).toMatchObject({ disabledReason: reason });
        expect(
            agentRestartMenuEntry(agentTerminal({ lastProcessState: 'detached' }), reason),
        ).toMatchObject({ disabledReason: 'Resume the detached Agent first' });
    });
});

describe('terminalTabMenuEntries', () => {
    async function labels(terminal: TerminalRecord): Promise<Array<string | undefined>> {
        return serializeContextMenu(await terminalTabMenuEntries(terminal, false)).items.map(
            (item) => (item.type === 'separator' ? undefined : item.label),
        );
    }

    it('groups the Agent actions, the move, and the copy with separators', async () => {
        expect(await labels(agentTerminal({ kind: 'codex', provider: 'codex' }))).toEqual([
            'Open as Chat',
            'Restart Agent',
            undefined,
            'Move to New Session',
            undefined,
            'Copy Resume Command',
        ]);
    });

    it('leaves a Shell tab only its move, with no stray separators', async () => {
        expect(
            await labels(
                agentTerminal({ kind: 'shell', provider: undefined, agentSessionId: undefined }),
            ),
        ).toEqual(['Move to New Session']);
    });
});
