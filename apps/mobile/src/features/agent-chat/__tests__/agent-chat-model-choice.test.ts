import { agentChatSelectionView } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../../i18n/locale-store';
import {
    agentChatConfigureFailureMessage,
    agentChatConfigureScope,
    agentChatEffortHint,
    agentChatModelOptions,
    agentChatModelSheetNote,
    agentChatModelTrigger,
    agentChatUltracodeToggle,
    currentAgentChatConfigureError,
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
            isUltracode: false,
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

    describe('in Chinese', () => {
        afterEach(() => setLocale('en'));

        it('names the provider default and the effort in the reader language', () => {
            setLocale('zh-CN');
            expect(agentChatModelTrigger({ effort: 'medium', models }, true)).toMatchObject({
                model: '默认',
                effort: '中',
            });
            expect(
                agentChatModelOptions({ model: 'opus', models }).efforts.map(
                    (effort) => effort.label,
                ),
            ).toEqual(['低', '高', '超高']);
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
            'Applies to the next turn.',
        );
        expect(agentChatModelSheetNote({})).toBeUndefined();
    });

    it('lists the chosen model and its efforts before the Server reports the switch', () => {
        const reported = { model: 'claude-opus-5-5', effort: 'xhigh', models: [...models] };
        const pending = {
            change: { model: 'sonnet' },
            baseline: { model: reported.model, effort: reported.effort },
            isAccepted: false,
        };
        const withSonnet = [
            ...models,
            {
                id: 'sonnet',
                displayName: 'Sonnet',
                efforts: ['low', 'medium'],
                defaultEffort: 'medium',
            },
        ];
        const options = agentChatModelOptions(
            agentChatSelectionView({ ...reported, models: withSonnet }, pending),
        );
        expect(options.models.find((model) => model.isSelected)?.id).toBe('sonnet');
        // Sonnet does not offer Extra high, so its default shows selected, as the provider applies it.
        expect(options.efforts.map((effort) => [effort.value, effort.isSelected])).toEqual([
            ['low', false],
            ['medium', true],
        ]);
    });

    it('names what failed to switch', () => {
        expect(agentChatConfigureFailureMessage({ model: 'opus' })).toBe(
            'Unable to switch the model. Try again.',
        );
        expect(agentChatConfigureFailureMessage({ effort: 'high' })).toBe(
            'Unable to switch the reasoning effort. Try again.',
        );
    });

    it('drops a failure once the Chat choice or the connection changed', () => {
        const live = { disabledReason: undefined, isLive: true };
        const snapshot = { model: 'opus', effort: 'high', status: 'ready' as const };
        const scope = agentChatConfigureScope(snapshot, live);
        const error = { message: 'Unable to switch the model. Try again.', scope };
        expect(currentAgentChatConfigureError(error, scope)).toBe(error);
        // A streamed token advances the revision without touching the choice; the error stays readable.
        const streamed = { ...snapshot, revision: 42, activeTurnId: 'turn-1' };
        expect(currentAgentChatConfigureError(error, agentChatConfigureScope(streamed, live))).toBe(
            error,
        );
        expect(
            currentAgentChatConfigureError(
                error,
                agentChatConfigureScope({ ...snapshot, model: 'haiku' }, live),
            ),
        ).toBeNull();
        expect(
            currentAgentChatConfigureError(
                error,
                agentChatConfigureScope(snapshot, {
                    disabledReason: 'Reconnect to change the model.',
                    isLive: false,
                }),
            ),
        ).toBeNull();
        expect(currentAgentChatConfigureError(null, scope)).toBeNull();
    });

    it('offers Ultracode only while the provider reports it for the model, and marks the trigger', () => {
        expect(agentChatUltracodeToggle({ ultracode: false })).toEqual({
            label: 'Ultracode',
            description: 'Multi-agent workflows at any effort',
            isOn: false,
        });
        expect(agentChatUltracodeToggle({ ultracode: true })?.isOn).toBe(true);
        // Codex, Grok Build, and a Claude model without ultracode report no `ultracode` at all.
        expect(agentChatUltracodeToggle({})).toBeUndefined();
        expect(agentChatUltracodeToggle(undefined)).toBeUndefined();
        expect(
            agentChatModelTrigger(
                { model: 'claude-opus-5-5', effort: 'high', models, ultracode: true },
                true,
            ),
        ).toMatchObject({
            isUltracode: true,
            accessibilityLabel: 'Model: Opus, High effort, ultracode on',
        });
        expect(agentChatConfigureFailureMessage({ ultracode: true })).toBe(
            'Unable to turn on Ultracode. Try again.',
        );
        expect(agentChatConfigureFailureMessage({ ultracode: false })).toBe(
            'Unable to turn off Ultracode. Try again.',
        );
    });
});
