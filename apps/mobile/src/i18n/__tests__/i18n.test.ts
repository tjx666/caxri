import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '../locale-store';
import { enResources } from '../locales/en';
import { zhCNResources } from '../locales/zh-cn';
import { translate } from '../translate';

const compareText = (left: string, right: string) => left.localeCompare(right);

const placeholders = (text: string) =>
    text
        .matchAll(/\{\{\s*(\w+)\s*\}\}/g)
        .map((match) => String(match[1]))
        .toArray()
        .toSorted(compareText);

describe('mobile translate', () => {
    afterEach(() => setLocale('en'));

    it('follows the active locale', () => {
        expect(translate('common.close')).toBe('Close');
        setLocale('zh-CN');
        expect(translate('common.close')).toBe('关闭');
    });
});

describe('mobile locale resources', () => {
    it('translates every English key into a non-empty Chinese string with the same placeholders', () => {
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
