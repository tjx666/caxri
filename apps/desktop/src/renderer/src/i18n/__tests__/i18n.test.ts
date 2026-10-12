import { interpolate } from '@desktop-shared/i18n/interpolate';
import { resolveAppLocale } from '@desktop-shared/i18n/locale';
import { en as lobeEn } from '@lobehub/ui/i18n';
import { describe, expect, it } from 'vitest';

import { useLocaleStore } from '../locale-store';
import { enResources } from '../locales/en';
import { zhCNResources } from '../locales/zh-cn';
import { translate } from '../translate';

describe('resolveAppLocale', () => {
    it('honors an explicit preference over the system language', () => {
        expect(resolveAppLocale('en', ['zh-CN'])).toBe('en');
        expect(resolveAppLocale('zh-CN', ['en-US'])).toBe('zh-CN');
    });

    it('follows a Chinese system language and falls back to English otherwise', () => {
        expect(resolveAppLocale(null, ['zh-Hans-CN', 'en-US'])).toBe('zh-CN');
        expect(resolveAppLocale(undefined, ['zh-TW'])).toBe('zh-CN');
        expect(resolveAppLocale(null, ['ja-JP', 'zh-CN'])).toBe('en');
        expect(resolveAppLocale(null, [])).toBe('en');
    });
});

describe('interpolate', () => {
    it('fills named placeholders and keeps unknown ones visible', () => {
        expect(interpolate('Delete {{ name }}? ({{count}})', { name: 'a.ts', count: 2 })).toBe(
            'Delete a.ts? (2)',
        );
        expect(interpolate('Hello {{missing}}', { name: 'x' })).toBe('Hello {{missing}}');
    });
});

describe('translate', () => {
    it('reads the active locale from the store, including @lobehub/ui built-ins', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        expect(translate('common.close')).toBe('关闭');
        expect(translate('common.cancel')).toBe('取消');
        useLocaleStore.setState({ locale: 'en' });
        expect(translate('common.close')).toBe('Close');
    });
});

const compareText = (left: string, right: string) => left.localeCompare(right);

describe('locale resources', () => {
    const lobeKeys = new Set(Object.values(lobeEn).flatMap((namespace) => Object.keys(namespace)));

    it('never redefines an @lobehub/ui built-in key', () => {
        expect(Object.keys(enResources).filter((key) => lobeKeys.has(key))).toEqual([]);
    });

    it('translates every English key into a non-empty Chinese string with the same placeholders', () => {
        const placeholders = (text: string) =>
            text
                .matchAll(/\{\{\s*(\w+)\s*\}\}/g)
                .map((match) => String(match[1]))
                .toArray()
                .toSorted(compareText);
        for (const [key, english] of Object.entries(enResources)) {
            const chinese = (zhCNResources as Partial<Record<string, string>>)[key];
            expect(chinese, key).toBeTruthy();
            expect(placeholders(chinese ?? ''), key).toEqual(placeholders(english));
        }
        expect(Object.keys(zhCNResources).toSorted(compareText)).toEqual(
            Object.keys(enResources).toSorted(compareText),
        );
    });
});
