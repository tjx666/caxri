import { afterEach, describe, expect, it } from 'vitest';

import { useLocaleStore } from '../i18n';
import { formatCount, localeDateTimeFormat, localeNumberFormat } from './locale-format';

describe('locale formatters', () => {
    afterEach(() => useLocaleStore.setState({ locale: 'en' }));

    it('formats in the interface language rather than the system locale', () => {
        useLocaleStore.setState({ locale: 'en' });
        expect(formatCount(12_345)).toBe('12,345');
        expect(localeDateTimeFormat({ dateStyle: 'medium', timeZone: 'UTC' }).format(0)).toBe(
            'Jan 1, 1970',
        );
        useLocaleStore.setState({ locale: 'zh-CN' });
        expect(localeDateTimeFormat({ dateStyle: 'medium', timeZone: 'UTC' }).format(0)).toBe(
            '1970年1月1日',
        );
    });

    it('reuses one formatter per locale and option set', () => {
        expect(localeNumberFormat({ maximumFractionDigits: 2 }, 'en')).toBe(
            localeNumberFormat({ maximumFractionDigits: 2 }, 'en'),
        );
        expect(localeNumberFormat({ maximumFractionDigits: 2 }, 'en').format(99.956)).toBe('99.96');
    });
});
