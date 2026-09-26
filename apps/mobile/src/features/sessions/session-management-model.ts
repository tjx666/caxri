import { sessionRenameTitleSchema } from '@caxri/protocol';

/**
 * Validates a rename draft with the Server's own schema, so the Save button disables exactly when the Server would
 * reject the title. Returns the trimmed title to send, or null when the draft is invalid or unchanged.
 */
export const sessionRenameDraft = (draft: string, currentTitle: string): string | null => {
    const parsed = sessionRenameTitleSchema.safeParse(draft);
    if (!parsed.success || parsed.data === currentTitle) return null;
    return parsed.data;
};

export const sessionManagementErrorMessage = (error: unknown, fallback: string): string =>
    error instanceof Error && error.message ? error.message : fallback;
