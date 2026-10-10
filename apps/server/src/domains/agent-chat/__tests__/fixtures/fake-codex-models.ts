/**
 * The models the fake Codex app-server's `model/list` offers: one with three efforts and its default in the middle, and
 * a smaller one that accepts only `low`, so switching to it exercises the effort fallback.
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
    },
    {
        model: 'fake-codex-mini',
        displayName: 'Fake Codex Mini',
        description: 'A smaller fake model',
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }],
        defaultReasoningEffort: 'low',
    },
];
