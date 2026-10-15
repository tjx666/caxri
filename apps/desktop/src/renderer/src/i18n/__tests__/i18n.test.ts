import { interpolate, resolveAppLocale } from '@caxri/protocol';
import { desktop as enDesktop } from '@desktop-shared/i18n/en/desktop';
import { desktop as zhCNDesktop } from '@desktop-shared/i18n/zh-cn/desktop';
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

    it('names the shared command list in the UI language instead of the cmdk English default', () => {
        useLocaleStore.setState({ locale: 'zh-CN' });
        expect(translate('core.command.suggestions')).toBe('建议');
        useLocaleStore.setState({ locale: 'en' });
        expect(translate('core.command.suggestions')).toBe('Suggestions');
    });
});

const compareText = (left: string, right: string) => left.localeCompare(right);

const placeholders = (text: string) =>
    text
        .matchAll(/\{\{\s*(\w+)\s*\}\}/g)
        .map((match) => String(match[1]))
        .toArray()
        .toSorted(compareText);

/**
 * Asserts that `chinese` translates every `english` key into a non-empty string with the same placeholders, and adds no
 * key of its own.
 */
function expectTranslated(
    english: Readonly<Record<string, string>>,
    chinese: Readonly<Partial<Record<string, string>>>,
): void {
    for (const [key, text] of Object.entries(english)) {
        expect(chinese[key], key).toBeTruthy();
        expect(placeholders(chinese[key] ?? ''), key).toEqual(placeholders(text));
    }
    expect(Object.keys(chinese).toSorted(compareText)).toEqual(
        Object.keys(english).toSorted(compareText),
    );
}

describe('locale resources', () => {
    const lobeKeys = new Set(Object.values(lobeEn).flatMap((namespace) => Object.keys(namespace)));

    it('never redefines an @lobehub/ui built-in key', () => {
        expect(Object.keys(enResources).filter((key) => lobeKeys.has(key))).toEqual([]);
    });

    it('translates every English key into a non-empty Chinese string with the same placeholders', () => {
        expectTranslated(enResources, zhCNResources);
    });

    /**
     * The Main-only `desktop` namespace (native menus and dialogs, read by `main/locale.ts`) is not part of the
     * Renderer resources, so it needs its own pass through the same check.
     */
    it('translates every Main-only desktop key the same way', () => {
        expectTranslated(enDesktop, zhCNDesktop);
    });
});
