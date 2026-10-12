import { afterEach, describe, expect, it } from 'vitest';

import { mainLocale, setMainLanguage, translateCommandTitle, translateMain } from '../locale';

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
        expect(translateMain('desktop.quit.messageOther', { running: '3 terminals' })).toBe(
            'Quit Caxri while 3 terminals are running?',
        );
        setMainLanguage('zh-CN', []);
        expect(translateMain('desktop.dialog.cancel')).toBe('取消');
    });

    it('falls back to the English catalog title for an untranslated command', () => {
        setMainLanguage('zh-CN', []);
        expect(translateCommandTitle('example.missing', 'Example Title')).toBe('Example Title');
    });
});
