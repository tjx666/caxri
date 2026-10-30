import type { AgentAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatCommandChoice,
    agentChatMenuMatches,
    agentChatSkillNotice,
    shouldHoldAgentChatSendAsText,
} from '../agent-chat-commands';

const commands = [
    { name: 'compact', description: 'Summarize the conversation' },
    { name: 'review', argumentHint: '<path>' },
    { name: 'mcp:list' },
];

const skill = (invocation: string, description?: string): AgentAction => ({
    invocation,
    kind: 'skill',
    ...(description && { description }),
    requiresArguments: false,
    source: 'project',
});

const invocations = (actions: readonly AgentAction[]) => actions.map((action) => action.invocation);

describe('agentChatMenuMatches', () => {
    it('lists commands then skills for a bare slash and narrows while the user types', () => {
        const todo = [skill('$todo-sweep')];
        expect(invocations(agentChatMenuMatches('/', commands, todo) ?? [])).toEqual([
            '/new-session',
            '/compact',
            '/review',
            '/mcp:list',
            '$todo-sweep',
        ]);
        expect(invocations(agentChatMenuMatches('/REV', commands, undefined) ?? [])).toEqual([
            '/review',
        ]);
        expect(invocations(agentChatMenuMatches('/mcp:', commands, undefined) ?? [])[0]).toBe(
            '/mcp:list',
        );
    });

    it('finds a skill by name or description, and leads with skills after `$`', () => {
        const skills = [
            skill('$todo-sweep', 'Find stale TODOs'),
            skill('$commit', 'Compact commits'),
        ];
        expect(invocations(agentChatMenuMatches('/to', commands, skills) ?? [])).toEqual([
            '/new-session',
            '$todo-sweep',
        ]);
        expect(invocations(agentChatMenuMatches('$com', commands, skills) ?? [])).toEqual([
            '$commit',
            '/compact',
        ]);
        expect(invocations(agentChatMenuMatches('/summarize', commands, skills) ?? [])).toEqual([
            '/compact',
        ]);
    });

    it('keeps the command row when the provider already lists a skill as a command', () => {
        expect(
            agentChatMenuMatches('/review', commands, [skill('/review', 'Skill copy')])?.map(
                ({ kind, invocation }) => `${kind}:${invocation}`,
            ),
        ).toEqual(['command:/review']);
    });

    it('shows no menu mid-sentence, past the name, or with nothing to offer', () => {
        expect(agentChatMenuMatches('fix /rev', commands, undefined)).toBeUndefined();
        expect(agentChatMenuMatches('/review src', commands, undefined)).toBeUndefined();
    });

    it('leads with Caxri /new-session on every provider, ahead of a provider command of that name', () => {
        expect(invocations(agentChatMenuMatches('/', undefined, undefined) ?? [])).toEqual([
            '/new-session',
        ]);
        expect(invocations(agentChatMenuMatches('/', commands, undefined) ?? [])[0]).toBe(
            '/new-session',
        );
        const shadowed = agentChatMenuMatches('/new', [{ name: 'new-session' }], undefined) ?? [];
        expect(shadowed.map(({ source }) => source)).toEqual(['builtIn']);
        expect(agentChatMenuMatches('/new-session', undefined, undefined)).toHaveLength(1);
    });

    it('completes /new-session into the draft instead of sending it', () => {
        const [handoff] = agentChatMenuMatches('/new', undefined, undefined) ?? [];
        expect(handoff.argumentHint).toBeTruthy();
        expect(agentChatCommandChoice(handoff)).toEqual({
            kind: 'complete',
            draft: '/new-session ',
        });
    });

    it('keeps the menu open with no matches so a typo reads as a miss', () => {
        expect(agentChatMenuMatches('/zzz', commands, undefined)).toEqual([]);
        expect(agentChatMenuMatches('$zzz', undefined, [skill('$todo-sweep')])).toEqual([]);
    });
});

describe('agentChatSkillNotice', () => {
    it('reports loading, then a quiet note for a stopped Agent, then nothing', () => {
        expect(agentChatSkillNotice({ isPending: true, isUnavailable: false })).toEqual({
            text: 'Loading skills…',
            isLoading: true,
        });
        expect(agentChatSkillNotice({ isPending: false, isUnavailable: true })).toEqual({
            text: 'Skills appear once the Agent is running',
            isLoading: false,
        });
        expect(agentChatSkillNotice({ isPending: false, isUnavailable: false })).toBeUndefined();
    });
});

describe('shouldHoldAgentChatSendAsText', () => {
    const hold = (draft: string, confirmedDraft?: string) =>
        shouldHoldAgentChatSendAsText({
            confirmedDraft,
            draft,
            matches: agentChatMenuMatches(draft, commands, undefined),
        });

    it('holds the first send of an unknown command and lets the second through', () => {
        expect(hold('/zzz')).toBe(true);
        expect(hold('/zzz', '/zzz')).toBe(false);
        expect(hold('/zzz', '/zz')).toBe(true);
    });

    it('never holds a listed command, /new-session, ordinary text, or a skill', () => {
        expect(hold('/new-session')).toBe(false);
        expect(hold('/compact')).toBe(false);
        expect(hold('hello')).toBe(false);
        expect(hold('/zzz now')).toBe(false);
        expect(hold('$zzz')).toBe(false);
    });
});

describe('agentChatCommandChoice', () => {
    it('runs a command without arguments and completes one that takes them or a skill', () => {
        const [, compact, review] = agentChatMenuMatches('/', commands, undefined) ?? [];
        expect(agentChatCommandChoice(compact)).toEqual({
            kind: 'run',
            command: { name: 'compact' },
        });
        expect(agentChatCommandChoice(review)).toEqual({ kind: 'complete', draft: '/review ' });
        expect(agentChatCommandChoice(skill('$todo-sweep'))).toEqual({
            kind: 'complete',
            draft: '$todo-sweep ',
        });
    });
});
