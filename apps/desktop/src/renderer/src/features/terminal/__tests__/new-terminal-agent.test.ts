import type { ProcessState, TerminalKind, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, terminalKindSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    newTerminalAgentChoices,
    newTerminalCommandKind,
    resolveNewTerminalAgent,
    resolveNewTerminalTarget,
} from '../new-terminal-agent';

const CATALOG_ORDER: TerminalKind[] = [...agentProviderIds, 'shell'];

function orderOf(defaultAgent: TerminalKind | null): TerminalKind[] {
    return newTerminalAgentChoices(defaultAgent)
        .filter((choice) => choice.surface === 'pty')
        .map((choice) => choice.kind);
}

function terminal(kind: TerminalKind, lastProcessState: ProcessState = 'running'): TerminalRecord {
    return { kind, lastProcessState } as TerminalRecord;
}

describe('resolveNewTerminalAgent', () => {
    it('answers with the configured default Agent', () => {
        expect(resolveNewTerminalAgent('claude')).toBe('claude');
        expect(resolveNewTerminalAgent('shell')).toBe('shell');
    });

    it('answers null when the user configured no default Agent', () => {
        expect(resolveNewTerminalAgent(null)).toBeNull();
        expect(resolveNewTerminalAgent(undefined)).toBeNull();
    });
});

describe('resolveNewTerminalTarget', () => {
    it('prefers the primary Terminal’s Agent over the configured default', () => {
        expect(resolveNewTerminalTarget(terminal('claude'), 'codex')).toBe('claude');
    });

    it('prefers the primary Terminal’s Agent while it is still starting', () => {
        expect(resolveNewTerminalTarget(terminal('claude', 'starting'), 'codex')).toBe('claude');
    });

    it('falls back to the configured default when the primary Terminal is a plain shell', () => {
        expect(resolveNewTerminalTarget(terminal('shell'), 'codex')).toBe('codex');
    });

    it.each<ProcessState>(['stopped', 'failed', 'dead', 'interrupted', 'suspended', 'detached'])(
        'falls back to the configured default when the primary Agent Terminal is %s',
        (lastProcessState) => {
            expect(resolveNewTerminalTarget(terminal('claude', lastProcessState), 'codex')).toBe(
                'codex',
            );
        },
    );

    it('falls back to the configured default when there is no primary Terminal', () => {
        expect(resolveNewTerminalTarget(undefined, 'codex')).toBe('codex');
    });

    it('answers null when neither the primary Terminal nor a default Agent resolves', () => {
        expect(resolveNewTerminalTarget(terminal('shell'), null)).toBeNull();
        expect(resolveNewTerminalTarget(undefined, null)).toBeNull();
    });
});

describe('newTerminalCommandKind', () => {
    it('creates the configured default Agent', () => {
        expect(newTerminalCommandKind('codex')).toBe('codex');
    });

    it('falls back to a shell when no default Agent is configured', () => {
        expect(newTerminalCommandKind(null)).toBe('shell');
        expect(newTerminalCommandKind(undefined)).toBe('shell');
    });
});

describe('newTerminalAgentChoices', () => {
    it('offers every Terminal kind exactly once, in catalog order', () => {
        expect(orderOf(null)).toEqual(CATALOG_ORDER);
        expect(CATALOG_ORDER).toHaveLength(terminalKindSchema.options.length);
    });

    it('keeps that order whichever Agent is the default', () => {
        for (const kind of CATALOG_ORDER) expect(orderOf(kind)).toEqual(CATALOG_ORDER);
    });

    it('marks the configured default and nothing else', () => {
        expect(newTerminalAgentChoices('grok').filter((choice) => choice.isDefault)).toEqual([
            { isDefault: true, kind: 'grok', surface: 'pty' },
        ]);
    });

    it('follows each Agent that supports Agent Chat with its Chat entry', () => {
        const choices = newTerminalAgentChoices(null).map(
            ({ kind, surface }) => `${kind}:${surface}`,
        );
        const chatKinds = agentProviderIds.filter(
            (provider) => agentProviderCatalog[provider].capabilities.chat,
        );
        expect(chatKinds.length).toBeGreaterThan(0);
        for (const kind of chatKinds)
            expect(choices.indexOf(`${kind}:chat`)).toBe(choices.indexOf(`${kind}:pty`) + 1);
        expect(choices.filter((choice) => choice.endsWith(':chat'))).toHaveLength(chatKinds.length);
    });

    it('marks nothing when no default Agent is configured', () => {
        expect(newTerminalAgentChoices(null).some((choice) => choice.isDefault)).toBe(false);
    });
});
