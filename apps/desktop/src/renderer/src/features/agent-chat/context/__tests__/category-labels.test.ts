import { describe, expect, it } from 'vitest';

import { contextCategoryId, contextCategoryLabel } from '../category-labels';

describe('contextCategoryLabel', () => {
    const t = (key: string) => `t:${key}`;

    it('translates a known provider row through its stable id', () => {
        expect(contextCategoryId('System prompt')).toBe('systemPrompt');
        expect(contextCategoryLabel(t, 'Free space')).toBe('t:agentChat.contextCategory.freeSpace');
        expect(contextCategoryLabel(t, 'Cached input')).toBe(
            't:agentChat.contextCategory.cachedInput',
        );
    });

    it('keeps an unknown row under the provider’s own name', () => {
        expect(contextCategoryId('Mystery')).toBeUndefined();
        expect(contextCategoryId('toString')).toBeUndefined();
        expect(contextCategoryLabel(t, 'Mystery')).toBe('Mystery');
    });
});
