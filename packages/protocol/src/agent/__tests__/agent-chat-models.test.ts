import { describe, expect, it } from 'vitest';

import type { AgentChatModel } from '../agent-chat-contract.js';
import { agentChatLabelsZhCN } from '../agent-chat-labels-zh-cn.js';
import type { AgentChatPendingSelection } from '../agent-chat-models.js';
import {
    agentChatEffortLabel,
    agentChatMenuModel,
    agentChatModelLabel,
    agentChatSelectionView,
    findAgentChatModel,
    isAgentChatSelectionSettled,
    resolveAgentChatModelChange,
} from '../agent-chat-models.js';

const SOL: AgentChatModel = {
    id: 'sol',
    displayName: 'Sol',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    fast: { description: '1.5x speed' },
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

    it('turns Fast mode on only for a model that offers it', () => {
        const fastSnapshot = { ...snapshot, fast: false };
        expect(resolveAgentChatModelChange(fastSnapshot, { fast: true })).toEqual({ fast: true });
        expect(resolveAgentChatModelChange(fastSnapshot, { fast: false })).toEqual({
            fast: false,
        });
        expect(() =>
            resolveAgentChatModelChange(fastSnapshot, { model: 'mini', fast: true }),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        // A provider that reports no Fast mode for this Chat cannot turn it on, whatever the model lists.
        expect(() => resolveAgentChatModelChange(snapshot, { fast: true })).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }),
        );
    });

    it('turns Fast mode off when switching to a model without it', () => {
        expect(resolveAgentChatModelChange({ ...snapshot, fast: true }, { model: 'mini' })).toEqual(
            { model: MINI, effort: 'low', fast: false },
        );
        expect(
            resolveAgentChatModelChange({ ...snapshot, fast: false }, { model: 'mini' }),
        ).toEqual({ model: MINI, effort: 'low' });
    });
});

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
        const chinese = (key: keyof typeof agentChatLabelsZhCN) => agentChatLabelsZhCN[key];
        expect(agentChatEffortLabel('medium', chinese)).toBe('中');
        expect(agentChatEffortLabel('turbo', chinese)).toBe('Turbo');
    });
});

describe('Agent Chat model selection', () => {
    const models: AgentChatModel[] = [
        { id: 'fast', displayName: 'Fast', efforts: ['low', 'medium'], defaultEffort: 'low' },
        {
            id: 'deep',
            displayName: 'Deep',
            efforts: ['medium', 'high'],
            defaultEffort: 'high',
            fast: { description: '1.5x speed' },
        },
    ];
    const snapshot = { model: 'fast', effort: 'medium', models };
    const pending = (
        change: AgentChatPendingSelection['change'],
        isAccepted = false,
    ): AgentChatPendingSelection => ({
        change,
        baseline: { model: 'fast', effort: 'medium' },
        isAccepted,
    });

    it('shows the requested model and effort while the switch is pending', () => {
        expect(agentChatSelectionView(snapshot, undefined)).toBe(snapshot);
        expect(agentChatSelectionView(snapshot, pending({ effort: 'low' }))).toMatchObject({
            model: 'fast',
            effort: 'low',
        });
        // The new model keeps an effort it offers and otherwise shows its default.
        expect(agentChatSelectionView(snapshot, pending({ model: 'deep' }))).toMatchObject({
            model: 'deep',
            effort: 'medium',
        });
        expect(
            agentChatSelectionView({ ...snapshot, effort: 'low' }, pending({ model: 'deep' })),
        ).toMatchObject({ model: 'deep', effort: 'high' });
    });

    it('settles once the snapshot reports the choice, or changes after Server Core accepted it', () => {
        expect(isAgentChatSelectionSettled(pending({ effort: 'low' }), snapshot)).toBe(false);
        expect(
            isAgentChatSelectionSettled(pending({ effort: 'low' }), { ...snapshot, effort: 'low' }),
        ).toBe(true);
        expect(
            isAgentChatSelectionSettled(pending({ model: 'deep', effort: 'high' }), {
                ...snapshot,
                model: 'deep',
            }),
        ).toBe(false);
        // An accepted switch the provider reports under another identifier still settles.
        expect(
            isAgentChatSelectionSettled(pending({ model: 'deep' }, true), {
                ...snapshot,
                model: 'deep-2026',
            }),
        ).toBe(true);
        expect(isAgentChatSelectionSettled(pending({ model: 'deep' }, true), snapshot)).toBe(false);
    });

    it('shows a pending Ultracode toggle until the snapshot reports it', () => {
        const withUltracode = { ...snapshot, ultracode: false };
        expect(agentChatSelectionView(withUltracode, pending({ ultracode: true }))).toMatchObject({
            ultracode: true,
        });
        expect(isAgentChatSelectionSettled(pending({ ultracode: true }), withUltracode)).toBe(
            false,
        );
        expect(
            isAgentChatSelectionSettled(pending({ ultracode: true }), {
                ...withUltracode,
                ultracode: true,
            }),
        ).toBe(true);
    });

    it('shows a pending Fast mode toggle, and Fast mode off on a new model without it', () => {
        const onDeep = { ...snapshot, model: 'deep', effort: 'high', fast: false };
        expect(agentChatSelectionView(onDeep, pending({ fast: true }))).toMatchObject({
            fast: true,
        });
        expect(isAgentChatSelectionSettled(pending({ fast: true }), onDeep)).toBe(false);
        expect(
            isAgentChatSelectionSettled(pending({ fast: true }), { ...onDeep, fast: true }),
        ).toBe(true);
        expect(
            agentChatSelectionView({ ...onDeep, fast: true }, pending({ model: 'fast' })),
        ).toMatchObject({ model: 'fast', fast: false });
    });
});

describe('agentChatMenuModel', () => {
    const fallback: AgentChatModel = { id: 'default', displayName: 'Default', efforts: ['medium'] };

    it('checks the provider default alias while no model is reported', () => {
        expect(agentChatMenuModel({ model: undefined, models: [SOL, fallback] })).toBe(fallback);
        expect(agentChatMenuModel({ model: undefined, models: [SOL] })).toBeUndefined();
    });

    it('follows the reported model once there is one', () => {
        expect(agentChatMenuModel({ model: 'sol', models: [SOL, fallback] })).toBe(SOL);
        expect(agentChatMenuModel({ model: 'unlisted', models: [fallback] })).toBeUndefined();
    });
});
