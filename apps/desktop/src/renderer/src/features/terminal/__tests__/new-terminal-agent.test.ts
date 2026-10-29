import type { ProcessState, TerminalKind, TerminalRecord, TerminalSurface } from '@caxri/protocol';
import { agentProviderIds, canUseAgentChat, terminalKindSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    agentChoiceMarker,
    agentInstallHint,
    isSameNewTerminalTarget,
    newAgentSurface,
    newSessionActionLabel,
    newTerminalActionLabel,
    newTerminalAgentChoices,
    newTerminalButtonText,
    newTerminalCommandKind,
    newTerminalCommandTarget,
    resolveNewTerminalAgent,
    resolveNewTerminalTarget,
    unavailableAgentKinds,
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
            [{ isDefault: true, isUnavailable: false, kind: 'grok', surface: 'pty' }],
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

describe('newTerminalActionLabel', () => {
    it('names the Agent and the view a press creates', () => {
        expect(newTerminalActionLabel({ kind: 'codex', surface: 'chat' }, 'Codex', translate)).toBe(
            'New Codex Chat',
        );
        expect(
            newTerminalActionLabel({ kind: 'claude', surface: 'pty' }, 'Claude Code', translate),
        ).toBe('New Claude Code Terminal');
    });

    it('keeps a Shell as a plain New Terminal', () => {
        expect(newTerminalActionLabel({ kind: 'shell', surface: 'pty' }, 'Shell', translate)).toBe(
            'New Terminal',
        );
    });
});

describe('newTerminalButtonText', () => {
    it('says New Chat only when the press opens a Chat', () => {
        expect(newTerminalButtonText('chat', translate)).toBe('New Chat');
        expect(newTerminalButtonText('pty', translate)).toBe('New Terminal');
    });
});

describe('newTerminalCommandTarget', () => {
    it('is what ⌘T creates: the default Agent on the preferred surface, or a Shell', () => {
        expect(newTerminalCommandTarget('codex', true)).toEqual({ kind: 'codex', surface: 'chat' });
        expect(newTerminalCommandTarget(null, true)).toEqual({ kind: 'shell', surface: 'pty' });
    });

    it('matches the + target only when both create the same Terminal', () => {
        const shortcut = newTerminalCommandTarget('codex', false);
        expect(isSameNewTerminalTarget(shortcut, { kind: 'codex', surface: 'pty' })).toBe(true);
        expect(isSameNewTerminalTarget(shortcut, { kind: 'codex', surface: 'chat' })).toBe(false);
        expect(isSameNewTerminalTarget(shortcut, { kind: 'claude', surface: 'pty' })).toBe(false);
    });
});

describe('newSessionActionLabel', () => {
    it('names the Agent and, for a Chat, the view', () => {
        expect(newSessionActionLabel({ kind: 'codex', surface: 'chat' }, 'Codex', translate)).toBe(
            'New Codex Chat Session',
        );
        expect(newSessionActionLabel({ kind: 'codex', surface: 'pty' }, 'Codex', translate)).toBe(
            'New Codex Session',
        );
        expect(newSessionActionLabel({ kind: 'shell', surface: 'pty' }, 'Shell', translate)).toBe(
            'New Shell Session',
        );
    });
});

describe('agentChoiceMarker', () => {
    it('merges the Chat and Default markers into one suffix', () => {
        expect(agentChoiceMarker({ isDefault: true, surface: 'chat' }, translate)).toBe(
            'Chat · Default',
        );
        expect(agentChoiceMarker({ isDefault: false, surface: 'chat' }, translate)).toBe('Chat');
        expect(agentChoiceMarker({ isDefault: true, surface: 'pty' }, translate)).toBe('Default');
        expect(agentChoiceMarker({ isDefault: false, surface: 'pty' }, translate)).toBeUndefined();
    });
});

describe('Agent availability annotations', () => {
    const availability = {
        providers: [
            { kind: 'claude', available: false },
            { kind: 'codex', available: true },
            { kind: 'grok', available: false },
        ],
    } as const;

    it('collects only the Agents the Server could not find', () => {
        expect([...unavailableAgentKinds({ providers: [...availability.providers] })]).toEqual([
            'claude',
            'grok',
        ]);
    });

    it('annotates nothing before the query answers or when it fails', () => {
        expect(unavailableAgentKinds(undefined).size).toBe(0);
    });

    it('keeps every Agent listed in catalog order and only flags the missing ones', () => {
        const unavailable = unavailableAgentKinds({ providers: [...availability.providers] });
        const choices = newTerminalAgentChoices('codex', false, unavailable);
        expect(choices.map(({ kind }) => kind)).toEqual(CATALOG_ORDER);
        expect(
            choices.filter(({ isUnavailable }) => isUnavailable).map(({ kind }) => kind),
        ).toEqual(['claude', 'grok']);
    });

    it('puts the Not installed suffix first and leaves installed rows unchanged', () => {
        expect(
            agentChoiceMarker({ isDefault: false, isUnavailable: true, surface: 'pty' }, translate),
        ).toBe('Not installed');
        expect(
            agentChoiceMarker({ isDefault: true, isUnavailable: true, surface: 'chat' }, translate),
        ).toBe('Not installed · Chat · Default');
        expect(
            agentChoiceMarker(
                { isDefault: true, isUnavailable: false, surface: 'chat' },
                translate,
            ),
        ).toBe('Chat · Default');
    });

    it('offers an install hint for each Agent CLI and none for Shell', () => {
        expect(agentInstallHint('claude', translate)).toContain('Claude Code');
        expect(agentInstallHint('codex', translate)).toContain('@openai/codex');
        expect(agentInstallHint('grok', translate)).toContain('Grok Build');
        expect(agentInstallHint('shell', translate)).toBeUndefined();
    });
});
