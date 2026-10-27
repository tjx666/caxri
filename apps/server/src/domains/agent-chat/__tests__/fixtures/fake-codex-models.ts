import { fakeCodexScript } from './fake-codex-script.ts';

const scriptedModel = fakeCodexScript()?.model;

/**
 * The id of the default model: `fake-codex-model`, or the model a `FAKE_CODEX_SCRIPT` renames it to.
 */
export const DEFAULT_MODEL_ID = scriptedModel?.id ?? 'fake-codex-model';

/**
 * The models the fake Codex app-server's `model/list` offers: one with three efforts, its default in the middle, and a
 * Fast service tier, and a smaller one that accepts only `low` and has no Fast tier, so switching to it exercises the
 * effort and Fast mode fallbacks.
 */
export const FAKE_MODELS = [
    {
        model: DEFAULT_MODEL_ID,
        displayName: scriptedModel?.displayName ?? 'Fake Codex',
        description: 'The default fake model',
        supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({
            reasoningEffort,
            description: reasoningEffort,
        })),
        defaultReasoningEffort: 'medium',
        serviceTiers: [
            { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' },
        ],
        defaultServiceTier: null,
    },
    {
        model: 'fake-codex-mini',
        displayName: 'Fake Codex Mini',
        description: 'A smaller fake model',
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }],
        defaultReasoningEffort: 'low',
        serviceTiers: [],
        defaultServiceTier: null,
    },
];
