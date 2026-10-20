import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    agentChatConfigureFailureMessage,
    agentChatEffortReset,
    agentChatEffortStop,
    agentChatMenuModel,
    agentChatModelTriggerText,
    agentChatPickerOpeningView,
    isAgentChatFastOffered,
} from './agent-chat-model-selection';

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

describe('Agent Chat model selection', () => {
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

describe('the effort panel', () => {
    const [low, deep] = models;

    it('opens on the model list only when there is nothing for the effort panel to set', () => {
        expect(agentChatPickerOpeningView(low, false)).toBe('effort');
        expect(agentChatPickerOpeningView({ ...low, efforts: [] }, true)).toBe('effort');
        expect(agentChatPickerOpeningView({ ...low, efforts: [] }, false)).toBe('models');
        expect(agentChatPickerOpeningView(undefined, false)).toBe('models');
    });

    it('puts an unlisted effort on the default stop, else the lowest', () => {
        expect(agentChatEffortStop(deep, 'high')).toBe(1);
        expect(agentChatEffortStop(deep, 'ultra')).toBe(1);
        expect(agentChatEffortStop(deep, undefined)).toBe(1);
        expect(agentChatEffortStop({ ...deep, defaultEffort: undefined }, 'ultra')).toBe(0);
    });

    it('resets to the default effort only when the model names one it is not already on', () => {
        expect(agentChatEffortReset(deep, 'medium')).toBe('high');
        expect(agentChatEffortReset(deep, 'high')).toBeUndefined();
        expect(
            agentChatEffortReset({ ...deep, defaultEffort: undefined }, 'medium'),
        ).toBeUndefined();
        expect(agentChatEffortReset({ ...deep, defaultEffort: 'max' }, 'medium')).toBeUndefined();
    });
});
