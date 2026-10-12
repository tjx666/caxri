import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    agentChatConfigureFailureMessage,
    agentChatMenuModel,
    agentChatModelTriggerText,
} from '../agent-chat-model-selection';

const models = [
    { id: 'fast', displayName: 'Fast', efforts: ['low', 'medium'], defaultEffort: 'low' },
    { id: 'deep', displayName: 'Deep', efforts: ['medium', 'high'], defaultEffort: 'high' },
];
const snapshot = { model: 'fast', effort: 'medium', models };

describe('Agent Chat model selection', () => {
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

    it('translates the unreported model as Default', () => {
        expect(
            agentChatModelTriggerText(translate, { ultracode: false }, { model: 'Default' })
                .ariaLabel,
        ).toBe('Model: Default');
    });
});
