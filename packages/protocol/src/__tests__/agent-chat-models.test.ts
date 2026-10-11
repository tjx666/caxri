import { describe, expect, it } from 'vitest';

import { agentChatEffortLabel, agentChatModelLabel } from '../agent/agent-chat-models.js';

describe('agentChatModelLabel', () => {
    const models = [
        { id: 'opus', resolvedId: 'claude-opus-5-5', displayName: 'Opus', efforts: ['high'] },
        { id: 'plain', displayName: 'Plain', efforts: [] },
    ];

    it('names the listed model and the effort the next turn uses', () => {
        expect(agentChatModelLabel(undefined)).toBeUndefined();
        // Claude Code lists its models before its first turn names the one in use.
        expect(agentChatModelLabel({ models })).toEqual({ model: 'Default' });
        // Claude Code reports the effort it will apply before that first turn.
        expect(agentChatModelLabel({ effort: 'medium', models })).toEqual({
            model: 'Default',
            effort: 'Medium',
        });
        expect(agentChatModelLabel({ model: 'claude-opus-5-5', effort: 'xhigh', models })).toEqual({
            model: 'Opus',
            effort: 'Extra high',
        });
        expect(agentChatModelLabel({ model: 'gpt-raw' })).toEqual({ model: 'gpt-raw' });
        // A model without effort control never shows a stale effort from the previous model.
        expect(agentChatModelLabel({ model: 'plain', effort: 'high', models })).toEqual({
            model: 'Plain',
        });
    });

    it('names the model Claude Code runs for its default alias instead of the alias', () => {
        const aliased = [
            {
                id: 'default',
                resolvedId: 'claude-opus-5-5[1m]',
                displayName: 'Default (recommended)',
                efforts: ['high'],
            },
            ...models,
        ];
        expect(agentChatModelLabel({ model: 'claude-opus-5-5[1m]', models: aliased })).toEqual({
            model: 'Opus',
        });
        expect(
            agentChatModelLabel({
                model: 'claude-opus-5-5[1m]',
                models: [
                    { ...aliased[0], description: 'Use the default model (currently Opus 5.5)' },
                    ...models,
                ],
            }),
        ).toEqual({ model: 'Opus 5.5' });
        // Without a named twin the alias still reads short.
        expect(
            agentChatModelLabel({ model: 'claude-opus-5-5[1m]', models: aliased.slice(0, 1) }),
        ).toEqual({ model: 'Default' });
    });

    it('labels known efforts and capitalizes unknown ones', () => {
        expect(agentChatEffortLabel('max')).toBe('Max');
        expect(agentChatEffortLabel('turbo')).toBe('Turbo');
    });
});
