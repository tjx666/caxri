import { describe, expect, it } from 'vitest';

import {
    composerActionsRequest,
    composerSuggestionTrigger,
    insertComposerSuggestion,
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

    it('asks the Server to rank actions by the typed name, without the leading slash', () => {
        const trigger = composerSuggestionTrigger('/mobile-sk');
        expect(composerActionsRequest('session-1', 'terminal-1', trigger!.query)).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            query: 'mobile-sk',
        });
    });

    it('omits the query for a bare slash', () => {
        expect(composerActionsRequest('session-1', 'terminal-1', '')).toEqual({
            sessionId: 'session-1',
            terminalId: 'terminal-1',
        });
    });
});
