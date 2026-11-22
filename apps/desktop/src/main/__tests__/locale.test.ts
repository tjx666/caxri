import { afterEach, describe, expect, it } from 'vitest';

import {
    formatTurnDuration,
    mainLocale,
    setMainLanguage,
    translateCommandTitle,
    translateMain,
} from '../locale';

describe('Main locale', () => {
    afterEach(() => {
        setMainLanguage(null, []);
    });

    it('follows the system language until the setting picks one', () => {
        setMainLanguage(null, ['zh-Hans-CN', 'en-US']);
        expect(mainLocale()).toBe('zh-CN');
        setMainLanguage('en', ['zh-Hans-CN', 'en-US']);
        expect(mainLocale()).toBe('en');
    });

    it('translates native copy with interpolation', () => {
        expect(translateMain('desktop.runningWork.detail', { running: '3 Terminals' })).toBe(
            'Running: 3 Terminals',
        );
        setMainLanguage('zh-CN', []);
        expect(translateMain('desktop.dialog.cancel')).toBe('取消');
    });

    it('falls back to the English catalog title for an untranslated command', () => {
        setMainLanguage('zh-CN', []);
        expect(translateCommandTitle('example.missing', 'Example Title')).toBe('Example Title');
    });
});

describe('formatTurnDuration', () => {
    afterEach(() => setMainLanguage(null, []));

    it('prints compact English units', () => {
        setMainLanguage('en', []);
        expect(formatTurnDuration(0)).toBe('1s');
        expect(formatTurnDuration(125_000)).toBe('2m 5s');
        expect(formatTurnDuration(120_000)).toBe('2m');
        expect(formatTurnDuration(3_900_000)).toBe('1h 5m');
        expect(formatTurnDuration(3_600_000)).toBe('1h');
    });

    it('prints Simplified Chinese units when the interface language is Chinese', () => {
        setMainLanguage('zh-CN', []);
        expect(formatTurnDuration(15_000)).toBe('15 秒');
        expect(formatTurnDuration(125_000)).toBe('2 分 5 秒');
        expect(formatTurnDuration(120_000)).toBe('2 分钟');
        expect(formatTurnDuration(3_900_000)).toBe('1 小时 5 分');
        expect(formatTurnDuration(3_600_000)).toBe('1 小时');
    });
});
