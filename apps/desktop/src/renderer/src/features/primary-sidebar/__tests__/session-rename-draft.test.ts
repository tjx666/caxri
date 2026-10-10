import { describe, expect, it } from 'vitest';

import {
    canSuggestSessionTitle,
    decideSessionRename,
    syncUntouchedRenameDraft,
} from '../session-rename-draft';

describe('decideSessionRename', () => {
    it('commits a draft that differs from the title the editor opened with', () => {
        expect(decideSessionRename('  Fix login  ', 'Untitled')).toEqual({
            kind: 'rename',
            displayTitle: 'Fix login',
        });
    });

    it('treats an untouched draft as a cancel', () => {
        expect(decideSessionRename('Untitled ', 'Untitled')).toEqual({ kind: 'unchanged' });
    });

    it('reports a blank draft as empty', () => {
        expect(decideSessionRename(' '.repeat(3), 'Untitled')).toEqual({ kind: 'empty' });
    });

    /**
     * The race this guards: the editor opens on `Untitled`, automatic naming lands meanwhile, and blur fires with the
     * stale draft. Comparing with the new current title would rename the Session back to `Untitled` and mark it
     * manual.
     */
    it('does not revert an automatic name that landed while the editor was open', () => {
        const baseline = 'Untitled';
        const currentTitleAfterAutoNaming = 'Refactor auth flow';
        expect(currentTitleAfterAutoNaming).not.toBe(baseline);
        expect(decideSessionRename('Untitled', baseline)).toEqual({ kind: 'unchanged' });
    });
});

describe('syncUntouchedRenameDraft', () => {
    it('adopts a new title while the draft is untouched', () => {
        expect(syncUntouchedRenameDraft('Untitled', 'Untitled', 'Refactor auth flow')).toBe(
            'Refactor auth flow',
        );
    });

    it('keeps an edited draft when a new title arrives', () => {
        expect(syncUntouchedRenameDraft('My name', 'Untitled', 'Refactor auth flow')).toBe(
            undefined,
        );
    });

    it('does nothing while the title is unchanged or the Session is gone', () => {
        expect(syncUntouchedRenameDraft('Untitled', 'Untitled', 'Untitled')).toBe(undefined);
        expect(syncUntouchedRenameDraft('Untitled', 'Untitled', undefined)).toBe(undefined);
    });
});

describe('canSuggestSessionTitle', () => {
    it('requires a primary Agent', () => {
        expect(canSuggestSessionTitle({ primaryAgentTerminalId: 'terminal-1' })).toBe(true);
        expect(canSuggestSessionTitle({ primaryAgentTerminalId: undefined })).toBe(false);
    });
});
