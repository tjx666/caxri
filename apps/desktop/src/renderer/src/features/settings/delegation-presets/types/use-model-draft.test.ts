import { expect, it } from 'vitest';

import { isModelDraftPending } from './use-model-draft';

it('treats untouched and whitespace-only changes as no edit', () => {
    expect(isModelDraftPending('gpt-5.5', 'gpt-5.5')).toBe(false);
    expect(isModelDraftPending(' gpt-5.5 ', 'gpt-5.5')).toBe(false);
    expect(isModelDraftPending('', undefined)).toBe(false);
});

it('flags a changed or cleared model as pending', () => {
    expect(isModelDraftPending('gpt-6', 'gpt-5.5')).toBe(true);
    expect(isModelDraftPending('', 'gpt-5.5')).toBe(true);
    expect(isModelDraftPending('gpt-6', undefined)).toBe(true);
});
