import { settingsSpec } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { settingsCatalog } from '../../../i18n/locales/en/settings-catalog';

const enCatalog: Readonly<Record<string, string>> = settingsCatalog;

/**
 * Settings search indexes the protocol catalog's English text, while the page renders the English locale entry. A drift
 * between them makes a row match a query its visible text does not contain, so the two must stay identical.
 */
describe('settings catalog English parity', () => {
    it('keeps each English title and description identical to the protocol catalog text', () => {
        const mismatches = settingsSpec.flatMap((spec) =>
            (
                [
                    ['title', spec.title],
                    ['description', 'description' in spec ? spec.description : undefined],
                ] as const
            )
                .filter(([, text]) => text !== undefined)
                .map(([field, text]) => {
                    const key = `settings.${spec.key}.${field}`;
                    return { key, protocol: text, english: enCatalog[key] };
                })
                .filter(({ protocol, english }) => protocol !== english),
        );
        expect(mismatches).toEqual([]);
    });
});
