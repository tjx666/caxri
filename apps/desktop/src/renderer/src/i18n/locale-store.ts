import type { AppLocale } from '@caxri/protocol';
import { resolveAppLocale } from '@desktop-shared/i18n/locale';

import { createStore } from '../lib/store';
import { systemLanguages } from './locale';

interface LocaleState {
    /**
     * The locale the interface currently renders in, already resolved from the `workbench.language` setting.
     */
    locale: AppLocale;
}

/**
 * Module-level mirror of the active locale for code outside React (stores, command handlers, toasts raised from
 * events). Starts from the system language so text shown before the Settings snapshot arrives (the loading screen, a
 * boot failure) is already localized; `I18nProvider` then keeps it in step with the setting.
 */
export const useLocaleStore = createStore<LocaleState>('locale', () => ({
    locale: resolveAppLocale(undefined, systemLanguages()),
}));
