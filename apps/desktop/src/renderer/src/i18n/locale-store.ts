import type { AppLocale } from '@caxri/protocol';
import { resolveAppLocale } from '@caxri/protocol';

import { createStore } from '../lib/store';
import { systemLanguages } from './locale';

interface LocaleState {
    /**
     * The locale the interface currently renders in, already resolved from the `workbench.language` setting.
     */
    locale: AppLocale;
}

/**
 * The single source of the active locale, read by `I18nProvider` for React and by `translate()` for code outside React
 * (stores, command handlers, toasts raised from events). Starts from the system language so text shown before the
 * Settings snapshot arrives (the loading screen, a boot failure) is already localized.
 */
export const useLocaleStore = createStore<LocaleState>('locale', () => ({
    locale: resolveAppLocale(undefined, systemLanguages()),
}));

/**
 * Applies a `workbench.language` preference. `null` and `undefined` follow the system language.
 *
 * Callers run this synchronously when the setting changes, before React renders the change, so a `translate()` call
 * made during that render already returns the new language.
 */
export function applyLanguagePreference(preference: AppLocale | null | undefined): void {
    const locale = resolveAppLocale(preference, systemLanguages());
    if (useLocaleStore.getState().locale !== locale) useLocaleStore.setState({ locale });
}
