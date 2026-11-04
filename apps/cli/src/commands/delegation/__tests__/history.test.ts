import type { DelegationHistoryEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { DELEGATION_COMMANDS } from '../commands';
import { renderDelegationHistory } from '../history';

const command = DELEGATION_COMMANDS.find((item) => item.method === 'agent.delegation.history')!;
const NOW = 1_700_000_000_000;

const entry = (overrides: Partial<DelegationHistoryEntry> = {}): DelegationHistoryEntry => ({
    delegationId: 'task-1',
    rootDelegationId: 'task-1',
    sessionId: 'session-1',
    outcome: 'completed',
    provider: 'codex',
    createdAt: NOW - 120_000,
    settledAt: NOW - 60_000,
    compacted: false,
    ...overrides,
});

describe('agent delegate history', () => {
    it('is a plain read for both an Agent and the owner', () => {
        expect(command.path).toEqual(['agent', 'delegate', 'history']);
        expect(command.quietKey).toBe('entries');
        expect(command.quietIdKey).toBe('delegationId');
        expect(command.requiresAgentEndpoint).toBeUndefined();
        expect(command.requiresHumanOwner).toBeUndefined();
    });

    it('parses the query, outcome, limit and cursor flags', () => {
        expect(command.parseParams([])).toEqual({});
        expect(
            command.parseParams([
                '--query',
                ' login ',
                '--outcome',
                'failed',
                '--limit',
                '5',
                '--after',
                'cursor',
            ]),
        ).toEqual({ query: 'login', outcome: 'failed', limit: 5, after: 'cursor' });
    });

    it('rejects bad flags and values with a specific message', () => {
        expect(() => command.parseParams(['--query', ' '])).toThrow(
            '--query must be 1 to 100 characters',
        );
        expect(() => command.parseParams(['--query', 'x'.repeat(101)])).toThrow(
            '--query must be 1 to 100 characters',
        );
        expect(() => command.parseParams(['--outcome', 'running'])).toThrow(/--outcome must be/u);
        expect(() => command.parseParams(['--limit', '0'])).toThrow(/1 to 50/u);
        expect(() => command.parseParams(['--limit', '51'])).toThrow(/1 to 50/u);
        expect(() => command.parseParams(['--limit', 'all'])).toThrow(/positive integer/u);
        expect(() => command.parseParams(['--session', 'x'])).toThrow(
            'Unexpected argument: --session',
        );
        expect(() => command.parseParams(['--query', 'a', '--query', 'b'])).toThrow(/once/u);
        expect(() => command.parseParams(['--query'])).toThrow(/with a value/u);
    });
});

describe('human history output', () => {
    it('prints a block per entry, leaves unknown counters out, and hints at the next page', () => {
        const output = renderDelegationHistory(
            {
                entries: [
                    entry({
                        title: 'Fix login',
                        summary: 'Fixed it.',
                        summarySource: 'authored',
                        selection: { model: 'gpt-5' },
                        usage: { scope: 'main-thread', inputTokens: 12_000, outputTokens: 800 },
                    }),
                    entry({
                        delegationId: 'task-2',
                        outcome: 'failed',
                        failure: 'provider_failed',
                    }),
                ],
                nextCursor: 'abc',
                hasMore: true,
            },
            NOW,
        );

        expect(output).toContain(
            'task-1  completed  codex/gpt-5  settled 1 minute ago  "Fix login"',
        );
        expect(output).toContain('  Fixed it.');
        expect(output).toContain('tokens: in 12000 out 800 (provider counters)');
        expect(output).not.toContain('cache');
        expect(output).not.toContain('reasoning');
        expect(output).toContain('task-2  failed (provider_failed)');
        // The second entry has no counters, so it prints no tokens line and never a zero.
        expect(output.match(/tokens:/gu)).toHaveLength(1);
        expect(output).not.toMatch(/ 0\b/u);
        expect(output.trimEnd().endsWith('More: --after abc')).toBe(true);
    });

    it('marks compacted entries and excerpt summaries, and has an empty message', () => {
        const output = renderDelegationHistory(
            {
                entries: [
                    entry({ compacted: true }),
                    entry({
                        delegationId: 'task-3',
                        summary: 'First paragraph.',
                        summarySource: 'excerpt',
                    }),
                ],
                hasMore: false,
            },
            NOW,
        );

        expect(output).toContain('(details compacted)');
        expect(output).toContain('First paragraph. (excerpt of the answer)');
        expect(output).not.toContain('More:');
        expect(renderDelegationHistory({ entries: [], hasMore: false }, NOW)).toBe(
            'No delegated tasks match.\n',
        );
    });
});
