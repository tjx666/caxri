import { describe, expect, it } from 'vitest';

import { processExplorerLocaleFromSearch } from '../process-explorer-locale';

describe('processExplorerLocaleFromSearch', () => {
    it('reads the locale Main resolved from workbench.language', () => {
        expect(processExplorerLocaleFromSearch('?caxri-locale=zh-CN')).toBe('zh-CN');
        expect(processExplorerLocaleFromSearch('?caxri-test-render-error=1&caxri-locale=en')).toBe(
            'en',
        );
    });

    it('keeps the system language for an absent or unknown locale', () => {
        expect(processExplorerLocaleFromSearch('')).toBeUndefined();
        expect(processExplorerLocaleFromSearch('?caxri-locale=fr')).toBeUndefined();
        expect(processExplorerLocaleFromSearch('?caxri-locale=toString')).toBeUndefined();
    });
});
