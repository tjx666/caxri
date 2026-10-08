import { describe, expect, it } from 'vitest';

import type { DefaultSettingChange } from '../settings-changes';
import { defaultSettingsChanges, reconcileDefaultSettings } from '../settings-changes';
import { settingsSpecByKey } from '../settings-spec';

const CHANGES: readonly DefaultSettingChange[] = [
    { key: 'terminal.wordSeparators', previous: 'old', current: 'new' },
];

describe('Default settings reconciliation', () => {
    it('adopts a new default only for a file still holding the superseded one', () => {
        expect(
            reconcileDefaultSettings({ 'terminal.wordSeparators': 'old' }, CHANGES),
        ).toHaveLength(1);
        expect(reconcileDefaultSettings({ 'terminal.wordSeparators': 'new' }, CHANGES)).toEqual([]);
    });

    /**
     * The whole point of matching the previous default exactly: a value the user chose is theirs, even when it looks
     * like an accident of an old release.
     */
    it('leaves a customized value alone', () => {
        expect(reconcileDefaultSettings({ 'terminal.wordSeparators': ' |' }, CHANGES)).toEqual([]);
    });

    /**
     * An absent key already parses to the current default through the schema, so it must not be rewritten: otherwise
     * every reconciliation would materialize keys the user deliberately left out.
     */
    it('ignores a key the file does not carry', () => {
        expect(reconcileDefaultSettings({}, CHANGES)).toEqual([]);
    });

    it('ships every change with a current value that matches the live default', () => {
        for (const change of defaultSettingsChanges) {
            // The table is keyed across every spec kind, and a `complex` setting carries no `default` to compare.
            const spec = settingsSpecByKey[change.key] as { default?: unknown };
            expect(change.current).toEqual(spec.default);
            expect(change.current).not.toEqual(change.previous);
        }
    });

    /**
     * The Terminal separators are the reason this table exists: an install created before Chinese punctuation joined
     * them kept selecting a whole sentence on double-click, because `settings.jsonc` froze the old default on disk.
     */
    it('carries the Terminal word separators forward to Chinese punctuation', () => {
        const [adopted] = reconcileDefaultSettings({
            'terminal.wordSeparators': ' ()[]{}\',"`─‘’“”|',
        });

        expect(adopted.key).toBe('terminal.wordSeparators');
        expect(adopted.current).toContain('，');
    });
});
