import type { JSONPath } from 'jsonc-parser';
import { applyEdits, modify } from 'jsonc-parser';

import { formatCount } from '../../lib/locale-format';

/**
 * The three configuration files editable from the Settings dialog, also used as the fixed Apply-All save order
 * (settings before keybindings before theme) so partial failures are deterministic to reproduce.
 */
export const CONFIG_KINDS = ['settings', 'keybindings', 'theme'] as const;

export type ConfigKind = (typeof CONFIG_KINDS)[number];

/**
 * File names shown to the user when reporting which tab failed to save.
 */
export const CONFIG_FILE_NAMES: Record<ConfigKind, string> = {
    settings: 'settings.jsonc',
    keybindings: 'keybindings.jsonc',
    theme: 'theme.json',
};

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: '\n' };

/**
 * Applies one value change to JSONC source text at `path`, preserving comments and the surrounding formatting instead
 * of re-serializing the whole document. Every structured form control (settings fields, keybinding rows, theme color
 * pickers) must go through this function so edits made in the form never destroy comments a user added by hand.
 */
export function applyFormEdit(source: string, path: JSONPath, value: unknown): string {
    const edits = modify(source, path, value, { formattingOptions: FORMATTING_OPTIONS });
    return applyEdits(source, edits);
}

const BYTES_PER_MEBIBYTE = 1024 * 1024;

/**
 * Converts a persisted byte count into the MB value shown/edited in the form.
 */
export function bytesToMebibytes(bytes: number): number {
    return Math.round((bytes / BYTES_PER_MEBIBYTE) * 1_000_000) / 1_000_000;
}

/**
 * Converts a user-entered MB value back into the byte count that is actually persisted.
 */
export function mebibytesToBytes(mebibytes: number): number {
    return Math.round(mebibytes * BYTES_PER_MEBIBYTE);
}

/**
 * Names the unit of the number in the field. The stored value is a raw byte count, but the field is unit-aware and the
 * UI never says "bytes" at the user.
 */
export function formatByteHint(bytes: number): string {
    return `${formatCount(bytesToMebibytes(bytes))} MB`;
}
