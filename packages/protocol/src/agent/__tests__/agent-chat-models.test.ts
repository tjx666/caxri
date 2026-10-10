import { describe, expect, it } from 'vitest';

import type { AgentChatModel } from '../agent-chat-contract.js';
import { findAgentChatModel, resolveAgentChatModelChange } from '../agent-chat-models.js';

const SOL: AgentChatModel = {
    id: 'sol',
    displayName: 'Sol',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
};
const MINI: AgentChatModel = {
    id: 'mini',
    displayName: 'Mini',
    efforts: ['low', 'medium'],
    defaultEffort: 'low',
};
const OPUS: AgentChatModel = {
    id: 'opus',
    resolvedId: 'claude-opus-5-5',
    displayName: 'Opus',
    efforts: ['low', 'high', 'max'],
};
const PLAIN: AgentChatModel = { id: 'plain', displayName: 'Plain', efforts: [] };
const models = [SOL, MINI, OPUS, PLAIN];

describe('findAgentChatModel', () => {
    it('matches a listed alias by the full model the provider reports', () => {
        expect(findAgentChatModel(models, 'claude-opus-5-5')).toBe(OPUS);
        expect(findAgentChatModel(models, 'sol')).toBe(SOL);
        expect(findAgentChatModel(models, 'unknown')).toBeUndefined();
        expect(findAgentChatModel(undefined, 'sol')).toBeUndefined();
    });
});

describe('resolveAgentChatModelChange', () => {
    const snapshot = { model: 'sol', effort: 'xhigh', models };

    it('switches the effort of the model in use', () => {
        expect(resolveAgentChatModelChange(snapshot, { effort: 'low' })).toEqual({
            effort: 'low',
        });
        expect(
            resolveAgentChatModelChange(
                { ...snapshot, model: 'claude-opus-5-5' },
                { effort: 'max' },
            ),
        ).toEqual({ effort: 'max' });
    });

    it('falls back to the new model default when it does not accept the current effort', () => {
        expect(resolveAgentChatModelChange(snapshot, { model: 'mini' })).toEqual({
            model: MINI,
            effort: 'low',
        });
        expect(
            resolveAgentChatModelChange({ ...snapshot, effort: 'medium' }, { model: 'mini' }),
        ).toEqual({ model: MINI });
        expect(resolveAgentChatModelChange(snapshot, { model: 'plain' })).toEqual({
            model: PLAIN,
        });
    });

    it('steps down to the closest accepted effort when the new model names no default', () => {
        expect(
            resolveAgentChatModelChange({ ...snapshot, effort: 'xhigh' }, { model: 'opus' }),
        ).toEqual({ model: OPUS, effort: 'high' });
        expect(
            resolveAgentChatModelChange({ ...snapshot, effort: 'minimal' }, { model: 'opus' }),
        ).toEqual({ model: OPUS, effort: 'low' });
    });

    it('takes an explicit effort for the model being switched to', () => {
        expect(resolveAgentChatModelChange(snapshot, { model: 'opus', effort: 'max' })).toEqual({
            model: OPUS,
            effort: 'max',
        });
    });

    it('rejects a model or effort the provider never offered', () => {
        expect(() => resolveAgentChatModelChange(snapshot, { model: 'gone' })).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }),
        );
        expect(() => resolveAgentChatModelChange(snapshot, { effort: 'max' })).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }),
        );
        expect(() =>
            resolveAgentChatModelChange({ ...snapshot, models: undefined }, { effort: 'low' }),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        expect(() =>
            resolveAgentChatModelChange(snapshot, { model: 'plain', effort: 'low' }),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    });
});
