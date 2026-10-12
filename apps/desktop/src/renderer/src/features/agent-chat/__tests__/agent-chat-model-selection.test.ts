import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import type { AgentChatPendingSelection } from '../agent-chat-model-selection';
import {
    agentChatConfigureFailureMessage,
    agentChatMenuModel,
    agentChatModelTriggerText,
    agentChatSelectionView,
    isAgentChatFastOffered,
    isAgentChatSelectionSettled,
} from '../agent-chat-model-selection';

const models = [
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

describe('Agent Chat model selection', () => {
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

    it('offers Fast mode only when the provider reports it and the model lists it', () => {
        const [plain, deep] = models;
        expect(isAgentChatFastOffered({ fast: false }, deep)).toBe(true);
        expect(isAgentChatFastOffered({ fast: false }, plain)).toBe(false);
        expect(isAgentChatFastOffered({}, deep)).toBe(false);
        expect(isAgentChatFastOffered({ fast: false }, undefined)).toBe(false);
    });

    it('names what failed to switch', () => {
        expect(agentChatConfigureFailureMessage({ effort: 'high' })).toBe(
            'Unable to switch the effort',
        );
        expect(agentChatConfigureFailureMessage({ model: 'deep' })).toBe(
            'Unable to switch the model',
        );
        expect(agentChatConfigureFailureMessage({ ultracode: true })).toBe(
            'Unable to turn on Ultracode',
        );
        expect(agentChatConfigureFailureMessage({ fast: false })).toBe(
            'Unable to turn off Fast mode',
        );
    });
});

describe('agentChatMenuModel', () => {
    it('checks the listed model in use, matching an alias by its resolved id', () => {
        expect(agentChatMenuModel(snapshot)?.id).toBe('fast');
        expect(
            agentChatMenuModel({
                model: 'claude-opus-5-5',
                models: [
                    { id: 'opus', displayName: 'Opus', resolvedId: 'claude-opus-5-5', efforts: [] },
                ],
            })?.id,
        ).toBe('opus');
    });

    it('checks the default alias before the provider names its model, so its efforts show', () => {
        const withDefault = [
            { id: 'default', displayName: 'Default (recommended)', efforts: ['low', 'medium'] },
            ...models,
        ];
        expect(agentChatMenuModel({ model: undefined, models: withDefault })?.id).toBe('default');
        expect(agentChatMenuModel({ model: undefined, models })).toBeUndefined();
        expect(agentChatMenuModel({ model: 'unlisted', models: withDefault })).toBeUndefined();
    });
});

describe('agentChatModelTriggerText', () => {
    it('names the trigger with the model, effort, and ultracode state', () => {
        expect(
            agentChatModelTriggerText(
                translate,
                { model: 'fast', effort: 'high', ultracode: true },
                { model: 'Fast', effort: 'High' },
            ),
        ).toEqual({
            modelName: 'Fast',
            effortName: 'High',
            ariaLabel: 'Model: Fast, High effort, ultracode on',
        });
    });

    it('names Fast mode in the trigger when it is on', () => {
        expect(
            agentChatModelTriggerText(
                translate,
                { model: 'deep', effort: 'high', fast: true },
                { model: 'Deep', effort: 'High' },
            ).ariaLabel,
        ).toBe('Model: Deep, High effort, Fast mode on');
    });

    it('translates the unreported model as Default', () => {
        expect(
            agentChatModelTriggerText(translate, { ultracode: false }, { model: 'Default' })
                .ariaLabel,
        ).toBe('Model: Default');
    });
});
