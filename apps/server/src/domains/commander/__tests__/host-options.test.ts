import type { TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { commanderHostOptions } from '../host-options';

function hostOptions(surface: 'chat' | 'pty') {
    const agentChat = {
        closeSession: vi.fn(() => Promise.resolve()),
        resumeSession: vi.fn(),
    };
    const terminals = { suspend: vi.fn(() => Promise.resolve(true)) };
    const restoreTerminals = vi.fn();
    const options = commanderHostOptions({
        agentChat,
        coordinator: { probeTerminal: vi.fn() },
        database: {
            getTerminal: (id) =>
                ({ id, sessionId: 'commander-session', surface }) as TerminalRecord,
        },
        createAndStartTerminal: vi.fn(),
        onStopped: vi.fn(),
        restores: { cancel: vi.fn(), settled: () => Promise.resolve() },
        restoreTerminals,
        scopedWorkbench: vi.fn(),
        send: vi.fn(),
        sendFullStateChange: vi.fn(),
        terminals: terminals as never,
    });
    return { agentChat, options, restoreTerminals, terminals };
}

describe('commanderHostOptions', () => {
    it('parks a Chat Commander through the Chat service', async () => {
        const { agentChat, options, terminals } = hostOptions('chat');

        await options.stopTerminal('commander-terminal');
        expect(agentChat.closeSession).toHaveBeenCalledWith('commander-session', 'detached');
        expect(terminals.suspend).not.toHaveBeenCalled();
    });

    it('parks a PTY Commander by suspending its Terminal', async () => {
        const { agentChat, options, terminals } = hostOptions('pty');

        await options.stopTerminal('commander-terminal');
        expect(terminals.suspend).toHaveBeenCalledWith('commander-terminal', 'detached');
        expect(agentChat.closeSession).not.toHaveBeenCalled();
    });

    it('resumes a detached Commander on either surface', () => {
        const { agentChat, options, restoreTerminals } = hostOptions('chat');

        options.restoreTerminals('commander-session');
        expect(restoreTerminals).toHaveBeenCalledWith('commander-session', {
            includeDetached: true,
        });
        expect(agentChat.resumeSession).toHaveBeenCalledWith('commander-session');
    });
});
