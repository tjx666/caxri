import { afterEach, describe, expect, it, vi } from 'vitest';

import { translate, useLocaleStore } from '../i18n';
import { useWorkbenchStore } from './workbench';
import { syncWorkbenchLocale } from './workbench-locale';

vi.mock('../lib/caxri', () => ({ caxri: {} }));

type Bootstrap = NonNullable<ReturnType<typeof useWorkbenchStore.getState>['bootstrap']>;

const withLanguage = (language: 'en' | 'zh-CN' | null) => ({
    bootstrap: { settings: { 'workbench.language': language } } as unknown as Bootstrap,
});

describe('syncWorkbenchLocale', () => {
    afterEach(() => {
        useWorkbenchStore.setState({ bootstrap: undefined });
        useLocaleStore.setState({ locale: 'en' });
    });

    it('switches translate() inside the same snapshot write, before React can render it', () => {
        syncWorkbenchLocale();
        const seen: string[] = [];
        // A listener subscribed after the sync stands in for React's store subscription.
        const unsubscribe = useWorkbenchStore.subscribe(() => seen.push(translate('common.close')));
        useWorkbenchStore.setState(withLanguage('zh-CN'));
        expect(seen).toEqual(['关闭']);
        useWorkbenchStore.setState(withLanguage(null));
        expect(useLocaleStore.getState().locale).toBe('en');
        unsubscribe();
    });
});
