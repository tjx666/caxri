import process from 'node:process';

import { TreeItem } from 'caxri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    activateExtension,
    configureExtensions,
    extensionApiBinding,
    getTreeChildren,
    notifyLanguageChanged,
} from '../api-factory';
import { setAppLanguage } from '../app-language';
import type { ExtensionViewEventScope } from '../protocol';
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
        vi.useRealTimers();
        vi.restoreAllMocks();
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

    /**
     * A tree provider's own refresh outside a Server scope is dropped, so a Status tree read in English stayed in
     * English after a switch to Chinese until the user refreshed it.
     */
    it('re-reads every loaded tree scope in that scope', async () => {
        const session: ExtensionViewEventScope = {
            kind: 'session',
            sessionId: 'session-a',
            workbenchRootProjectId: 'project-1',
        };
        configureExtensions([localizedRegistration()]);
        const { api } = extensionApiBinding('fixture-token-1');
        api.views.registerTreeDataProvider('publisher.fixture.tree', {
            getChildren: () => ['root'],
            getTreeItem: (element: string) =>
                new TreeItem(api.l10n.t('Hello {name}', { name: element })),
        });
        await getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'language-tree',
            context: session,
        });
        vi.useFakeTimers();
        vi.spyOn(process, 'connected', 'get').mockReturnValue(true);
        const sent: unknown[] = [];
        process.send = ((message: unknown) => sent.push(message) > 0) as typeof process.send;

        notifyLanguageChanged('zh-CN');
        await vi.runAllTimersAsync();
        delete process.send;

        expect(sent).toEqual([
            expect.objectContaining({
                event: 'treeChanged',
                viewId: 'publisher.fixture.tree',
                context: session,
            }),
        ]);
    });
});
