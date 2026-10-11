import { describe, expect, it } from 'vitest';

import {
    agentChatEffortHint,
    agentChatModelOptions,
    agentChatModelSheetNote,
    agentChatModelTrigger,
} from '../agent-chat-model-choice';

const models = [
    {
        id: 'opus',
        resolvedId: 'claude-opus-5-5',
        displayName: 'Opus',
        description: 'Most capable',
        efforts: ['low', 'high', 'xhigh'],
        defaultEffort: 'high',
    },
    { id: 'haiku', displayName: 'Haiku', efforts: [] },
];

describe('Agent Chat model choice', () => {
    it('labels the trigger like Desktop and opens only with listed models and access', () => {
        expect(agentChatModelTrigger(undefined, true)).toBeUndefined();
        expect(
            agentChatModelTrigger({ model: 'claude-opus-5-5', effort: 'xhigh', models }, true),
        ).toEqual({
            model: 'Opus',
            effort: 'Extra high',
            isInteractive: true,
            accessibilityLabel: 'Model: Opus, Extra high effort',
        });
        expect(agentChatModelTrigger({ model: 'opus', models }, false)?.isInteractive).toBe(false);
        // A provider that lists no models shows its model as plain text.
        expect(agentChatModelTrigger({ model: 'gpt-raw' }, true)).toMatchObject({
            model: 'gpt-raw',
            isInteractive: false,
        });
    });

    it('lists models with the selection and the current model efforts with their default', () => {
        const options = agentChatModelOptions({ model: 'claude-opus-5-5', effort: 'low', models });
        expect(options.models.map((model) => [model.id, model.isSelected])).toEqual([
            ['opus', true],
            ['haiku', false],
        ]);
        expect(options.efforts).toEqual([
            { value: 'low', label: 'Low', isDefault: false, isSelected: true },
            { value: 'high', label: 'High', isDefault: true, isSelected: false },
            { value: 'xhigh', label: 'Extra high', isDefault: false, isSelected: false },
        ]);
        expect(agentChatModelOptions({ model: 'haiku', models }).efforts).toEqual([]);
    });

    it('asks for a model before offering efforts when the provider has not named one yet', () => {
        expect(agentChatEffortHint({ models })).toBe(
            'Choose a model to see its reasoning efforts.',
        );
        expect(agentChatModelOptions({ models }).efforts).toEqual([]);
        expect(agentChatEffortHint({ model: 'opus', models })).toBeUndefined();
        expect(agentChatEffortHint({ model: 'gpt-raw' })).toBeUndefined();
    });

    it('says a running turn keeps its model', () => {
        expect(agentChatModelSheetNote({ activeTurnId: 'turn-1' })).toBe(
            'Applies from the next turn.',
        );
        expect(agentChatModelSheetNote({})).toBeUndefined();
    });
});
