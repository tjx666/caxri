import { z } from 'zod';

/**
 * Drafts the phone keeps across a cold start, matching Desktop's Agent Chat draft limits.
 */
export const SAVED_DRAFTS_MAX_ENTRIES = 50;
export const SAVED_DRAFTS_MAX_CHARACTERS = 1_000_000;

/**
 * `[sessionId, draft]` pairs, oldest first.
 */
export const savedDraftsSchema = z
    .array(z.tuple([z.string().min(1), z.string().min(1)]))
    .max(SAVED_DRAFTS_MAX_ENTRIES);

export type SavedDrafts = z.infer<typeof savedDraftsSchema>;

/**
 * The newest drafts that fit both limits, oldest first. A single draft over the character limit is not saved rather
 * than cut, since a truncated message is worse than a missing one.
 */
export const draftsToSave = (draftBySession: Readonly<Record<string, string>>): SavedDrafts => {
    const kept: SavedDrafts = [];
    let characters = 0;
    const entries = Object.entries(draftBySession);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (kept.length === SAVED_DRAFTS_MAX_ENTRIES) break;
        const [sessionId, draft] = entries[index];
        if (draft === '' || characters + draft.length > SAVED_DRAFTS_MAX_CHARACTERS) continue;
        characters += draft.length;
        // Built newest first and prepended, so the result stays oldest first without an ES2023 `toReversed` on Hermes.
        kept.unshift([sessionId, draft]);
    }
    return kept;
};

/**
 * Restores saved drafts under what the user already typed in this launch: a live draft always wins.
 */
export const mergeSavedDrafts = (
    draftBySession: Readonly<Record<string, string>>,
    saved: SavedDrafts,
): Record<string, string> => ({ ...Object.fromEntries(saved), ...draftBySession });
