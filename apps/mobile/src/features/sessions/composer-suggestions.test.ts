import { describe, expect, it } from 'vitest';

import {
    composerSuggestionTrigger,
    insertComposerSuggestion,
    isComposerActionMatch,
} from './composer-suggestions';

describe('composer suggestions', () => {
    it('detects a trailing action or file token', () => {
        expect(composerSuggestionTrigger('fix @src/fo')).toEqual({
            kind: 'file',
            token: '@src/fo',
            query: 'src/fo',
        });
        expect(composerSuggestionTrigger('/mod')).toEqual({
            kind: 'action',
            token: '/mod',
            query: 'mod',
        });
        expect(composerSuggestionTrigger('plain text')).toBeNull();
    });

    it('replaces only the active token', () => {
        expect(insertComposerSuggestion('look at @src/fo', '@src/fo', '@src/foo.ts')).toBe(
            'look at @src/foo.ts ',
        );
    });

    it('finds slash commands and dollar-prefixed skills from the same menu', () => {
        expect(isComposerActionMatch('/model', 'mod')).toBe(true);
        expect(isComposerActionMatch('$mobile-skill', 'mobile')).toBe(true);
        expect(isComposerActionMatch('$mobile-skill', 'model')).toBe(false);
    });
});
