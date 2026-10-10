import type { ProcessState, TerminalKind, TerminalRecord, TerminalSurface } from '@caxri/protocol';
import { agentProviderIds, canUseAgentChat, terminalKindSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    newAgentSurface,
    newTerminalAgentChoices,
    newTerminalCommandKind,
    resolveNewTerminalAgent,
    resolveNewTerminalTarget,
} from '../new-terminal-agent';

const CATALOG_ORDER: TerminalKind[] = [...agentProviderIds, 'shell'];

function orderOf(defaultAgent: TerminalKind | null): TerminalKind[] {
    return newTerminalAgentChoices(defaultAgent, false).map((choice) => choice.kind);
}

function terminal(
    kind: TerminalKind,
    lastProcessState: ProcessState = 'running',
    surface?: TerminalSurface,
): TerminalRecord {
    return { kind, lastProcessState, ...(surface && { surface }) } as TerminalRecord;
}

function pty(kind: TerminalKind) {
    return { kind, surface: 'pty' };
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
        expect(resolveNewTerminalTarget(terminal('claude'), 'codex', false)).toEqual(pty('claude'));
    });

    it('clones a live Agent Chat as a Chat, not a PTY', () => {
        expect(
            resolveNewTerminalTarget(terminal('codex', 'running', 'chat'), 'claude', false),
        ).toEqual({
            kind: 'codex',
            surface: 'chat',
        });
    });

    it('prefers the primary Terminal’s Agent while it is still starting', () => {
        expect(resolveNewTerminalTarget(terminal('claude', 'starting'), 'codex', false)).toEqual(
            pty('claude'),
        );
    });

    it('falls back to the configured default when the primary Terminal is a plain shell', () => {
        expect(resolveNewTerminalTarget(terminal('shell'), 'codex', false)).toEqual(pty('codex'));
    });

    it.each<ProcessState>(['stopped', 'failed', 'dead', 'interrupted', 'suspended', 'detached'])(
        'falls back to the configured default when the primary Agent Terminal is %s',
        (lastProcessState) => {
            expect(
                resolveNewTerminalTarget(terminal('claude', lastProcessState), 'codex', false),
            ).toEqual(pty('codex'));
        },
    );

    it('falls back to the configured default when there is no primary Terminal', () => {
        expect(resolveNewTerminalTarget(undefined, 'codex', false)).toEqual(pty('codex'));
    });

    it('answers null when neither the primary Terminal nor a default Agent resolves', () => {
        expect(resolveNewTerminalTarget(terminal('shell'), null, false)).toBeNull();
        expect(resolveNewTerminalTarget(undefined, null, false)).toBeNull();
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
        expect(newTerminalAgentChoices('grok', false).filter((choice) => choice.isDefault)).toEqual(
            [{ isDefault: true, kind: 'grok', surface: 'pty' }],
        );
    });

    it('switches only Chat-capable Agents to Chat when Open in Chat is on', () => {
        const chatKinds = agentProviderIds.filter((provider) => canUseAgentChat(provider));
        expect(chatKinds.length).toBeGreaterThan(0);
        const choices = newTerminalAgentChoices(null, true);
        expect(choices.map((choice) => choice.kind)).toEqual(CATALOG_ORDER);
        for (const { kind, surface } of choices)
            expect(surface).toBe((chatKinds as TerminalKind[]).includes(kind) ? 'chat' : 'pty');
    });

    it('marks nothing when no default Agent is configured', () => {
        expect(newTerminalAgentChoices(null, false).some((choice) => choice.isDefault)).toBe(false);
    });
});

describe('newAgentSurface', () => {
    it('opens a Chat-capable Agent as a Chat only when Open in Chat is on', () => {
        expect(newAgentSurface('codex', true)).toBe('chat');
        expect(newAgentSurface('codex', false)).toBe('pty');
        expect(newAgentSurface('codex', undefined)).toBe('pty');
        expect(newAgentSurface('grok', true)).toBe('chat');
    });

    it('keeps the shell on a PTY', () => {
        expect(newAgentSurface('shell', true)).toBe('pty');
    });
});

describe('resolveNewTerminalTarget with Open in Chat', () => {
    it('falls back to the default Agent as a Chat', () => {
        expect(resolveNewTerminalTarget(undefined, 'codex', true)).toEqual({
            kind: 'codex',
            surface: 'chat',
        });
    });

    it('still clones a live PTY primary Agent as a PTY', () => {
        expect(resolveNewTerminalTarget(terminal('codex'), 'codex', true)).toEqual(pty('codex'));
    });
});
