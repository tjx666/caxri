import { describe, expect, it } from 'vitest';

import {
    agentActionInvocationSchema,
    defaultAgentActions,
    MAX_AGENT_ACTIONS,
    mergeAgentActions,
} from '../agent-action-contract';

describe('agent action contract', () => {
    it('ships only the curated non-destructive provider fallback', () => {
        expect(defaultAgentActions.codex.map((action) => action.invocation)).toEqual([
            '/model',
            '/compact',
            '/diff',
            '/review',
            '/status',
        ]);
        expect(defaultAgentActions.claude.map((action) => action.invocation)).toEqual([
            '/model',
            '/compact',
            '/diff',
            '/review',
            '/context',
        ]);
        expect(defaultAgentActions.codex.map((action) => action.invocation)).not.toContain(
            '/clear',
        );
    });

    it('applies discovered metadata and user overrides in precedence order', () => {
        const actions = mergeAgentActions(
            'codex',
            [
                {
                    invocation: '$commit',
                    kind: 'skill',
                    description: 'Discovered commit workflow',
                    requiresArguments: false,
                    source: 'project',
                },
                {
                    invocation: '/review',
                    kind: 'command',
                    description: 'Provider-specific review',
                    requiresArguments: false,
                    source: 'project',
                },
            ],
            {
                items: {
                    '/review': { enabled: false },
                    '/goal': { enabled: true, description: 'Manage a long-running goal' },
                    '$commit': { enabled: true, description: 'Commit the current changes' },
                },
            },
        );

        expect(actions.find((action) => action.invocation === '/review')).toBeUndefined();
        expect(actions.find((action) => action.invocation === '/goal')).toMatchObject({
            kind: 'command',
            source: 'custom',
        });
        expect(actions.find((action) => action.invocation === '$commit')).toMatchObject({
            description: 'Commit the current changes',
            kind: 'skill',
            source: 'project',
        });
    });

    it('rejects whitespace, control characters, and missing invocation prefixes', () => {
        for (const invocation of ['review', '/two words', '/line\nbreak', '$']) {
            expect(agentActionInvocationSchema.safeParse(invocation).success).toBe(false);
        }
        expect(agentActionInvocationSchema.safeParse('/review').success).toBe(true);
        expect(agentActionInvocationSchema.safeParse('$commit').success).toBe(true);
    });

    it('bounds the merged result after applying precedence', () => {
        const discovered = Array.from({ length: MAX_AGENT_ACTIONS + 10 }, (_, index) => ({
            invocation: `/action-${index}`,
            kind: 'command' as const,
            requiresArguments: false,
            source: 'project' as const,
        }));

        const actions = mergeAgentActions('codex', discovered, {
            items: { '/zz-user-action': { enabled: true } },
        });

        expect(actions).toHaveLength(MAX_AGENT_ACTIONS);
        expect(actions.map((action) => action.invocation)).toEqual(
            expect.arrayContaining(['/zz-user-action', '/status']),
        );
    });

    it('recomputes required arguments when a user overrides the argument hint', () => {
        const actions = mergeAgentActions('codex', [], {
            items: {
                '/required': { enabled: true, argumentHint: '<target>' },
                '/optional': { enabled: true, argumentHint: '[target]' },
            },
        });

        expect(actions.find((action) => action.invocation === '/required')).toMatchObject({
            argumentHint: '<target>',
            requiresArguments: true,
        });
        expect(actions.find((action) => action.invocation === '/optional')).toMatchObject({
            argumentHint: '[target]',
            requiresArguments: false,
        });
    });
});
