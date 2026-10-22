import { describe, expect, it } from 'vitest';

import {
    draftsToSave,
    mergeSavedDrafts,
    SAVED_DRAFTS_MAX_CHARACTERS,
    SAVED_DRAFTS_MAX_ENTRIES,
    savedDraftsSchema,
} from '../saved-drafts';
import { emptyHostSessionUiState, rememberSessionDraft } from '../session-ui-state';

describe('saved drafts', () => {
    it('keeps drafts newest last and forgets one the user cleared or sent', () => {
        let state = emptyHostSessionUiState();
        state = rememberSessionDraft(state, 'one', 'first');
        state = rememberSessionDraft(state, 'two', 'second');
        state = rememberSessionDraft(state, 'one', 'first, edited');
        expect(draftsToSave(state.draftBySession)).toEqual([
            ['two', 'second'],
            ['one', 'first, edited'],
        ]);
        state = rememberSessionDraft(state, 'two', '');
        expect(draftsToSave(state.draftBySession)).toEqual([['one', 'first, edited']]);
    });

    it('saves only the newest drafts that fit both limits, never a cut draft', () => {
        const many = Object.fromEntries(
            Array.from({ length: SAVED_DRAFTS_MAX_ENTRIES + 5 }, (_, index) => [`s${index}`, 'x']),
        );
        const saved = draftsToSave(many);
        expect(saved).toHaveLength(SAVED_DRAFTS_MAX_ENTRIES);
        expect(saved[0]).toEqual(['s5', 'x']);
        expect(savedDraftsSchema.safeParse(saved).success).toBe(true);

        const huge = 'y'.repeat(SAVED_DRAFTS_MAX_CHARACTERS);
        expect(draftsToSave({ old: 'kept', big: huge, newest: 'z' })).toEqual([
            ['old', 'kept'],
            ['newest', 'z'],
        ]);
    });

    it('restores saved drafts without replacing one typed since launch', () => {
        expect(
            mergeSavedDrafts({ two: 'typed now' }, [
                ['one', 'saved one'],
                ['two', 'saved two'],
            ]),
        ).toEqual({ one: 'saved one', two: 'typed now' });
    });
});
