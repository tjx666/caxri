/**
 * The models the fake Codex app-server's `model/list` offers: one with three efforts, its default in the middle, and a
 * Fast service tier, and a smaller one that accepts only `low` and has no Fast tier, so switching to it exercises the
 * effort and Fast mode fallbacks.
 */
export const FAKE_MODELS = [
    {
        model: 'fake-codex-model',
        displayName: 'Fake Codex',
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
