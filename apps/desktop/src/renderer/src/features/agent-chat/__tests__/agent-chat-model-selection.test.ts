import { describe, expect, it } from 'vitest';

import type { AgentChatPendingSelection } from '../agent-chat-model-selection';
import {
    agentChatConfigureFailureMessage,
    agentChatMenuModel,
    agentChatSelectionView,
    isAgentChatSelectionSettled,
} from '../agent-chat-model-selection';

const models = [
    { id: 'fast', displayName: 'Fast', efforts: ['low', 'medium'], defaultEffort: 'low' },
    { id: 'deep', displayName: 'Deep', efforts: ['medium', 'high'], defaultEffort: 'high' },
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
