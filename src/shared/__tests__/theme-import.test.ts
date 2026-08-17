import { describe, expect, it } from 'vitest';

import { themeImportFormatIds } from '../ipc/domain';
import { themeImportExtensions, themeImportFormats } from '../theme-import';

describe('themeImportFormats', () => {
    it('registers exactly the protocol import-format ids in catalog order', () => {
        expect(themeImportFormats.map((format) => format.id)).toEqual([...themeImportFormatIds]);
    });

    it('exposes the union of declared extensions for the file picker', () => {
        expect(themeImportExtensions).toEqual(['itermcolors', 'yaml', 'yml', 'json', 'jsonc']);
    });
});
