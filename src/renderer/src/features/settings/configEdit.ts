import { applyEdits, modify, type JSONPath } from 'jsonc-parser';

/**
 * The three configuration files editable from the Settings dialog, also used as the
 * fixed Apply-All save order (settings before keybindings before theme) so partial
 * failures are deterministic to reproduce.
 */
export const CONFIG_KINDS = ['settings', 'keybindings', 'theme'] as const;

export type ConfigKind = (typeof CONFIG_KINDS)[number];

/** File names shown to the user when reporting which tab failed to save. */
export const CONFIG_FILE_NAMES: Record<ConfigKind, string> = {
    settings: 'settings.jsonc',
    keybindings: 'keybindings.jsonc',
    theme: 'theme.json',
};

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: '\n' };

/**
 * Applies one value change to JSONC source text at `path`, preserving comments and the
 * surrounding formatting instead of re-serializing the whole document. Every structured
 * form control (settings fields, keybinding rows, theme color pickers) must go through
 * this function so edits made in the form never destroy comments a user added by hand.
 */
export function applyFormEdit(source: string, path: JSONPath, value: unknown): string {
    const edits = modify(source, path, value, { formattingOptions: FORMATTING_OPTIONS });
    return applyEdits(source, edits);
}

/** Per-kind pair of the current draft text and the text last loaded from or saved to disk. */
export interface ConfigDraft {
    source: string;
    appliedSource: string;
}

export type ConfigDrafts = Record<ConfigKind, ConfigDraft>;

/** A kind is dirty when its draft text no longer matches the last loaded/applied text. */
export function isConfigDirty(draft: ConfigDraft): boolean {
    return draft.source !== draft.appliedSource;
}

/** Returns the dirty kinds in the fixed save order used by Apply-All. */
export function dirtyConfigKinds(drafts: ConfigDrafts): ConfigKind[] {
    return CONFIG_KINDS.filter((kind) => isConfigDirty(drafts[kind]));
}

const BYTES_PER_MEBIBYTE = 1024 * 1024;

/** Converts a persisted byte count into the MB value shown/edited in the form. */
export function bytesToMebibytes(bytes: number): number {
    return Math.round((bytes / BYTES_PER_MEBIBYTE) * 1_000_000) / 1_000_000;
}

/** Converts a user-entered MB value back into the byte count that is actually persisted. */
export function mebibytesToBytes(mebibytes: number): number {
    return Math.round(mebibytes * BYTES_PER_MEBIBYTE);
}

/** Secondary text showing the exact persisted byte value next to the human-readable MB field. */
export function formatByteHint(bytes: number): string {
    return `${bytes.toLocaleString('en-US')} bytes`;
}
