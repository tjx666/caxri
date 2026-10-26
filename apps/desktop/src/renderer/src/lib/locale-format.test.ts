import { afterEach, describe, expect, it } from 'vitest';

import { useLocaleStore } from '../i18n';
import {
    formatCount,
    formatDate,
    formatDateTime,
    formatTime,
    localeDateTimeFormat,
    localeNumberFormat,
} from './locale-format';

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

    describe('date and time helpers', () => {
        // Built from local fields so the expectations hold in any time zone.
        const moment = new Date(2024, 0, 5, 7, 4, 9);

        it('formats a date and time with seconds per locale', () => {
            expect(formatDateTime(moment, 'en')).toBe('1/5/2024, 7:04:09 AM');
            expect(formatDateTime(moment, 'zh-CN')).toBe('2024/1/5 07:04:09');
        });

        it('formats a numeric date per locale', () => {
            expect(formatDate(moment, 'en')).toBe('1/5/2024');
            expect(formatDate(moment, 'zh-CN')).toBe('2024/1/5');
        });

        it('adds seconds and a two-digit hour only when asked', () => {
            const clean = (text: string) => text.replaceAll(/\s/g, ' ');
            expect(clean(formatTime(moment, {}, 'en'))).toBe('7:04 AM');
            expect(clean(formatTime(moment, { withSeconds: true }, 'en'))).toBe('7:04:09 AM');
            expect(clean(formatTime(moment, { twoDigitHour: true }, 'en'))).toBe('07:04 AM');
            expect(formatTime(moment, { twoDigitHour: true, withSeconds: true }, 'zh-CN')).toBe(
                '07:04:09',
            );
        });

        it('defaults to the interface language from the store', () => {
            useLocaleStore.setState({ locale: 'en' });
            const en = formatDateTime(moment);
            useLocaleStore.setState({ locale: 'zh-CN' });
            expect(formatDateTime(moment)).not.toBe(en);
        });
    });
});
