import type { TerminalKind } from '@caxri/protocol';
import { agentProviderIds, terminalKindSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    newTerminalAgentChoices,
    newTerminalCommandKind,
    resolveNewTerminalAgent,
} from '../new-terminal-agent';

const CATALOG_ORDER: TerminalKind[] = [...agentProviderIds, 'shell'];

function orderOf(defaultAgent: TerminalKind | null): TerminalKind[] {
    return newTerminalAgentChoices(defaultAgent).map((choice) => choice.kind);
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
            { isDefault: true, kind: 'grok' },
        ]);
    });

    it('marks nothing when no default Agent is configured', () => {
        expect(newTerminalAgentChoices(null).some((choice) => choice.isDefault)).toBe(false);
    });
});
