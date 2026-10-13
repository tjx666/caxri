import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { commanderHostOptions } from '../host-options';

function hostOptions(surface: 'chat' | 'pty', homeDirectory = '/nonexistent-home') {
    const agentChat = {
        closeSession: vi.fn(() => Promise.resolve()),
        resumeSession: vi.fn(),
    };
    const terminals = { suspend: vi.fn(() => Promise.resolve(true)) };
    const restoreTerminals = vi.fn();
    const restartTerminal = vi.fn(() => Promise.resolve({} as TerminalRecord));
    const write = vi.fn();
    const logger = { write } as unknown as StructuredLogger;
    const options = commanderHostOptions({
        agentChat,
        agentEnvironment: { homeDirectory, variables: {} },
        coordinator: { probeTerminal: vi.fn() },
        database: {
            getTerminal: (id) =>
                ({ id, sessionId: 'commander-session', surface }) as TerminalRecord,
        },
        createAndStartTerminal: vi.fn(),
        logger,
        onStopped: vi.fn(),
        restores: { cancel: vi.fn(), settled: () => Promise.resolve() },
        restoreTerminals,
        restartTerminal,
        scopedWorkbench: vi.fn(),
        send: vi.fn(),
        sendFullStateChange: vi.fn(),
        terminals: terminals as never,
    });
    return { agentChat, options, restartTerminal, restoreTerminals, terminals, write };
}

describe('commanderHostOptions', () => {
    it('relaunches through the Workbench restart on a new conversation', async () => {
        const { options, restartTerminal } = hostOptions('pty');

        await options.relaunchFresh('commander-terminal');
        expect(restartTerminal).toHaveBeenCalledExactlyOnceWith({
            terminalId: 'commander-terminal',
            mode: 'fresh',
        });
    });

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

    it('trusts the workspace in Claude Code before a Claude Commander launches, and leaves Codex alone', async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-commander-host-'));
        onTestFinished(() => rm(home, { force: true, recursive: true }));
        await writeFile(join(home, '.claude.json'), '{}');
        const { options, write } = hostOptions('pty', home);

        await options.prepareLaunch?.('codex', '/workspace');
        expect(await readFile(join(home, '.claude.json'), 'utf8')).toBe('{}');
        expect(write).not.toHaveBeenCalled();

        await options.prepareLaunch?.('claude', '/workspace');
        const config: unknown = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
        expect(config).toEqual({
            projects: { '/workspace': { hasTrustDialogAccepted: true } },
        });
        expect(write).toHaveBeenCalledWith(
            'debug',
            logEventCatalog.agentCommander.claudeTrustPrepared,
            { fields: { outcome: 'granted' } },
        );
    });

    it('warns when Claude Code will still ask for trust', async () => {
        const { options, write } = hostOptions('pty');

        await options.prepareLaunch?.('claude', '/workspace');
        expect(write).toHaveBeenCalledWith(
            'warn',
            logEventCatalog.agentCommander.claudeTrustPrepared,
            { fields: { outcome: 'missing_config' } },
        );
    });
});
