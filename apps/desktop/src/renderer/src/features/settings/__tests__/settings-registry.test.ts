import { settingsSpec } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { settingsRows, titleNamedBindings } from '../settings-registry';

describe('settingsRows', () => {
    /**
     * Declaring a setting in the spec makes it readable, writable, and validated, and completely invisible. The
     * Settings page builds from this hand-written row list, so a key added to the spec without a row here is a setting
     * only someone editing `settings.jsonc` by hand can discover. `complex` keys are the exception: they have no
     * generic control and are rendered by a dedicated editor row keyed on its own id.
     */
    it('gives every scalar setting a row on the Settings page', () => {
        const rendered = new Set(settingsRows.map((row) => row.id));
        const missing = settingsSpec
            .filter((spec) => spec.kind !== 'complex')
            .map((spec) => spec.key)
            .filter((key) => !rendered.has(key));
        expect(missing).toEqual([]);
    });

    /**
     * The page is one flat virtualized list, so a category heading never owns the rows under it. Two controls sharing
     * an accessible name are therefore indistinguishable to assistive technology anywhere in the app, and to any test
     * that addresses a control by role and name.
     */
    it('gives every row a unique accessible name across categories', () => {
        const names = settingsRows
            .filter((row) => titleNamedBindings.has(row.binding.type))
            .map((row) => row.accessibleTitle);
        const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
        expect([...new Set(duplicates)]).toEqual([]);
    });

    it('keeps row ids unique so the virtualized list can key on them', () => {
        expect(new Set(settingsRows.map((row) => row.id)).size).toBe(settingsRows.length);
    });
});
