import { afterEach, describe, expect, it } from 'vitest';

import {
    activateExtension,
    configureExtensions,
    extensionApiBinding,
    notifyLanguageChanged,
} from '../api-factory';
import { setAppLanguage } from '../app-language';
import { installExtensionFixture, registration } from './api-factory.fixture';

installExtensionFixture();

function localizedRegistration() {
    return {
        ...registration(),
        l10n: { 'zh-CN': { 'Hello {name}': '你好 {name}' } },
    };
}

describe('Extension Host language', () => {
    afterEach(() => {
        notifyLanguageChanged('en');
    });

    it('translates through the bundle for the configured language and falls back to English', () => {
        setAppLanguage('zh-CN');
        configureExtensions([localizedRegistration()]);
        const { api } = extensionApiBinding('fixture-token-1');
        expect(api.env.language).toBe('zh-CN');
        expect(api.l10n.t('Hello {name}', { name: 'Caxri' })).toBe('你好 Caxri');
        expect(api.l10n.t('Untranslated {0}', 'copy')).toBe('Untranslated copy');
    });

    it('switches an already imported l10n and notifies activated extensions of the new language', async () => {
        configureExtensions([localizedRegistration()]);
        const { api } = extensionApiBinding('fixture-token-1');
        expect(api.l10n.t('Hello {name}', { name: 'Caxri' })).toBe('Hello Caxri');
        await activateExtension('publisher.fixture', 1);
        const changes: string[] = [];
        api.env.onDidChangeLanguage((language) => changes.push(language));

        expect(notifyLanguageChanged('zh-CN')).toEqual({ notified: 1 });

        expect(changes).toEqual(['zh-CN']);
        expect(api.env.language).toBe('zh-CN');
        expect(api.l10n.t('Hello {name}', { name: 'Caxri' })).toBe('你好 Caxri');
    });

    it('does not notify an extension that has not activated yet', () => {
        configureExtensions([localizedRegistration()]);
        const changes: string[] = [];
        extensionApiBinding('fixture-token-1').api.env.onDidChangeLanguage((language) =>
            changes.push(language),
        );
        expect(notifyLanguageChanged('zh-CN')).toEqual({ notified: 0 });
        expect(changes).toEqual([]);
    });
});
