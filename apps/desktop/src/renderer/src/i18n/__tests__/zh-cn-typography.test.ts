import { describe, expect, it } from 'vitest';

import { zhCNResources } from '../locales/zh-cn';

/**
 * Typography rules every zh-CN string follows, checked with `{{…}}` placeholders removed so interpolation never counts
 * as text. A number and a Han character are always separated by a space ("5 小时"), and a comma touching Chinese text is
 * the full-width "，", never the half-width ASCII comma.
 */
const RULES: ReadonlyArray<[name: string, pattern: RegExp]> = [
    ['number touches Chinese', /\d\p{Script=Han}|\p{Script=Han}\d/u],
    ['half-width comma in Chinese', /\p{Script=Han},|,\p{Script=Han}/u],
];

describe('zh-CN typography', () => {
    it('spaces numbers from Chinese and uses full-width commas', () => {
        const offenders = Object.entries(zhCNResources as Record<string, string>).flatMap(
            ([key, value]) => {
                const text = value.replaceAll(/\{\{[^}]*\}\}/gu, '');
                return RULES.filter(([, pattern]) => pattern.test(text)).map(
                    ([name]) => `${key}: ${name}`,
                );
            },
        );
        expect(offenders).toEqual([]);
    });
});
