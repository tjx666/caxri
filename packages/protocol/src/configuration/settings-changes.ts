/**
 * Reviewed changes to settings defaults that an existing `settings.jsonc` adopts without overwriting a deliberate
 * choice.
 *
 * A `settings.jsonc` is written with every key materialized at its default, so improving a default reaches nobody who
 * already has the file: the value they load is the one frozen on the day they first launched. This is the settings
 * counterpart of `defaultKeybindingChanges`, and it closes the same gap: a change applies only when the stored value is
 * still exactly the superseded default, and any other value is the user's and is left alone.
 */

import type { SettingKey } from './settings-spec.js';
import { settingsSpecByKey } from './settings-spec.js';

export interface DefaultSettingChange {
    key: SettingKey;
    /**
     * The default this entry supersedes. Only a file still holding this exact value is rewritten.
     */
    previous: unknown;
    current: unknown;
}

export const defaultSettingsChanges: readonly DefaultSettingChange[] = [
    {
        /*
         * Chinese punctuation joined the separators so double-click selection and fallback link detection stop at a
         * full-width comma. The Terminal is where Agent prose and paths share a line, so without it double-clicking an
         * identifier selected the rest of the sentence behind it.
         */
        key: 'terminal.wordSeparators',
        previous: ' ()[]{}\',"`─‘’“”|',
        current: settingsSpecByKey['terminal.wordSeparators'].default,
    },
];

/**
 * The subset of `changes` that this settings object still holds the superseded default for, in declaration order.
 */
export function reconcileDefaultSettings(
    settings: Readonly<Record<string, unknown>>,
    changes: readonly DefaultSettingChange[] = defaultSettingsChanges,
): DefaultSettingChange[] {
    return changes.filter((change) => {
        const stored = JSON.stringify(settings[change.key]);
        return (
            stored === JSON.stringify(change.previous) && stored !== JSON.stringify(change.current)
        );
    });
}
