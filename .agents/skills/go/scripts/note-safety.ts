import { redactSecretText } from '../../../../src/shared/redaction';

export const MAX_NOTE_TEXT_CHARACTERS = 4_096;

export interface SafeNoteText {
    redacted: boolean;
    text: string;
    truncated: boolean;
}

export function sanitizeNoteText(value: string, shouldTruncate = false): SafeNoteText {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('Note text is required');
    if (!shouldTruncate && trimmed.length > MAX_NOTE_TEXT_CHARACTERS) {
        throw new Error(`Note text exceeds ${MAX_NOTE_TEXT_CHARACTERS} characters`);
    }
    const bounded = shouldTruncate ? trimmed.slice(0, MAX_NOTE_TEXT_CHARACTERS) : trimmed;
    const text = redactSecretText(bounded);
    return {
        redacted: text !== bounded,
        text,
        truncated: bounded.length !== trimmed.length,
    };
}

export function sanitizeLedgerDetail(value: string): string {
    return redactSecretText(value).slice(0, MAX_NOTE_TEXT_CHARACTERS);
}
