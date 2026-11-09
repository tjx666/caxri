import type { AgentChatModel, AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { defaultChatChoiceRequest, nextChatChoice, restorableChatChoice } from '../stored-choice';

const models: AgentChatModel[] = [
    {
        id: 'default',
        displayName: 'Default',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
    },
    {
        id: 'opus',
        resolvedId: 'claude-opus',
        displayName: 'Opus',
        efforts: ['low', 'medium', 'high', 'max'],
        defaultEffort: 'high',
        fast: {},
    },
    { id: 'haiku', displayName: 'Haiku', efforts: [] },
];

type ChoiceSnapshot = Pick<AgentChatSnapshot, 'effort' | 'fast' | 'model' | 'models' | 'ultracode'>;

const fresh: ChoiceSnapshot = { models, effort: 'medium', ultracode: false, fast: false };

describe('nextChatChoice', () => {
    it('replaces the keys the user picked and keeps the rest', () => {
        expect(
            nextChatChoice(
                { model: 'opus', effort: 'max' },
                { ultracode: true },
                { ultracode: true },
            ),
        ).toEqual({ model: 'opus', effort: 'max', ultracode: true });
    });

    it('stops pinning an effort or Fast mode that a model switch moved on its own', () => {
        expect(
            nextChatChoice(
                { effort: 'max', fast: true },
                { model: 'haiku' },
                { model: models[2], effort: 'low', fast: false },
            ),
        ).toEqual({ model: 'haiku' });
    });
});

describe('restorableChatChoice', () => {
    it('sends the stored keys a fresh provider does not already run', () => {
        expect(
            restorableChatChoice(fresh, { model: 'opus', effort: 'max', ultracode: true }),
        ).toEqual({ request: { model: 'opus', effort: 'max', ultracode: true }, dropped: [] });
    });

    it('sends nothing when the provider restored the choice itself', () => {
        expect(
            restorableChatChoice(
                { ...fresh, model: 'claude-opus', effort: 'max' },
                { model: 'opus', effort: 'max' },
            ),
        ).toEqual({ request: {}, dropped: [] });
    });

    it('drops only the keys the provider no longer accepts', () => {
        expect(
            restorableChatChoice(
                { models, effort: 'medium', fast: false },
                { model: 'retired', effort: 'high', ultracode: true },
            ),
        ).toEqual({ request: { effort: 'high' }, dropped: ['model', 'ultracode'] });
        expect(restorableChatChoice(fresh, { model: 'haiku', effort: 'max' })).toEqual({
            request: { model: 'haiku' },
            dropped: ['effort'],
        });
    });

    it('waits for a later start when the provider listed no models', () => {
        expect(restorableChatChoice({ effort: 'medium' }, { model: 'opus' })).toBeUndefined();
    });
});

describe('defaultChatChoiceRequest', () => {
    it('switches to the configured default model and effort and turns ultracode off', () => {
        expect(
            defaultChatChoiceRequest(
                { ...fresh, model: 'haiku', effort: undefined, ultracode: true },
                { model: 'opus', effort: 'max' },
            ),
        ).toEqual({ model: 'opus', effort: 'max', ultracode: false });
    });

    it('falls back to the default alias and that model’s own effort when nothing is configured', () => {
        expect(
            defaultChatChoiceRequest({ ...fresh, model: 'claude-opus', effort: 'max' }, {}),
        ).toEqual({ model: 'default', effort: 'medium' });
    });

    it('uses the model’s default effort when the configured one does not fit it', () => {
        expect(
            defaultChatChoiceRequest(
                { ...fresh, model: 'claude-opus', effort: 'low' },
                {
                    effort: 'max',
                },
            ),
        ).toEqual({ model: 'default', effort: 'medium' });
    });

    it('sends nothing when the Chat already runs the default', () => {
        expect(defaultChatChoiceRequest(fresh, { effort: 'medium' })).toEqual({});
    });
});
