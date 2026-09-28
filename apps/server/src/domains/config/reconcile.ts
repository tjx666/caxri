/**
 * Turns one configuration file's bytes into the value the Server runs on, adopting reviewed default changes on the way.
 *
 * Each file is materialized on first launch with every key at its default, so improving a default afterwards reaches
 * nobody who already has the file. Reconciliation closes that gap without overwriting a deliberate choice: only a value
 * that still matches the exact superseded default is rewritten, and the rewritten bytes are re-validated before they
 * are handed back, so a reconciliation that would produce an invalid file fails loudly instead of landing.
 *
 * Kept out of `config.ts` because these are pure source-to-value transforms with no service state, which is also what
 * lets them be tested without a config directory on disk.
 */

import type { AppSettings, Keybinding, ThemeTokens } from '@caxri/protocol';
import {
    appSettingsFileSchema,
    configurationSourceSchema as configSourceSchema,
    defaultKeybindingChanges,
    keybindingsFileSchema,
    normalizeBuiltinTheme,
    reconcileDefaultKeybindings,
    reconcileDefaultSettings,
} from '@caxri/protocol';
import { parseJsonc } from '@caxri/system';
import { applyEdits, modify } from 'jsonc-parser';

import { parseCaxriTheme } from '../theme';

export const JSONC_FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: '\n' };

/**
 * The reconciled bytes plus the value they parse to. `source` equals the input whenever nothing was adopted, which is
 * how the caller decides whether the file needs to be written back at all.
 */
export interface PreparedSource<T> {
    source: string;
    value: T;
}

function edit(source: string, path: Array<string | number>, value: unknown): string {
    return applyEdits(
        source,
        modify(source, path, value, { formattingOptions: JSONC_FORMATTING_OPTIONS }),
    );
}

export function prepareSettingsSource(
    source: string,
    shouldReconcileDefaults: boolean,
): PreparedSource<AppSettings> {
    let preparedSource = source;
    let settings = appSettingsFileSchema.parse(parseJsonc(source));
    if (!shouldReconcileDefaults) return { source, value: settings };
    for (const change of reconcileDefaultSettings(settings))
        preparedSource = edit(preparedSource, [change.key], change.current);
    if (preparedSource !== source) {
        configSourceSchema.parse(preparedSource);
        settings = appSettingsFileSchema.parse(parseJsonc(preparedSource));
    }
    return { source: preparedSource, value: settings };
}

export function prepareKeybindingsSource(
    source: string,
    shouldReconcileDefaults: boolean,
): PreparedSource<Keybinding[]> {
    let preparedSource = source;
    let keybindings = keybindingsFileSchema.parse(parseJsonc(source));
    if (!shouldReconcileDefaults) return { source, value: keybindings };
    const reconciliation = reconcileDefaultKeybindings(keybindings, defaultKeybindingChanges);
    for (const replacement of reconciliation.replacements)
        for (const property of ['key', 'command', 'when'] as const)
            if (keybindings[replacement.index]?.[property] !== replacement.binding[property])
                preparedSource = edit(
                    preparedSource,
                    [replacement.index, property],
                    replacement.binding[property],
                );
    let bindingCount = keybindings.length;
    for (const addition of reconciliation.additions) {
        preparedSource = edit(preparedSource, [bindingCount], addition);
        bindingCount += 1;
    }
    if (preparedSource !== source) {
        configSourceSchema.parse(preparedSource);
        keybindings = keybindingsFileSchema.parse(parseJsonc(preparedSource));
    }
    return { source: preparedSource, value: keybindings };
}

export function prepareThemeSource(source: string): PreparedSource<ThemeTokens> {
    const parsedTheme = parseCaxriTheme(source);
    const theme = normalizeBuiltinTheme(parsedTheme);
    let preparedSource = source;
    if (theme !== parsedTheme)
        /**
         * Built-in identity is metadata. Editing only these two leaves preserves comments and formatting in externally
         * maintained JSONC theme files while preventing an edited preset from posing as built-in.
         */
        for (const property of ['id', 'source'] as const)
            preparedSource = edit(preparedSource, [property], theme[property]);
    return { source: preparedSource, value: theme };
}
