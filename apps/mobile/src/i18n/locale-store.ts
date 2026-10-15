import type { AppLocale } from '@caxri/protocol';
import { resolveAppLocale } from '@caxri/protocol';

import { notifyListeners } from '../lib/notify-listeners';

const state: { locale: AppLocale } = { locale: 'en' };
const listeners = new Set<(value: undefined) => void>();

/**
 * The language the phone renders in. It starts as English so tests and the first module evaluation are deterministic;
 * the root layout calls {@link syncSystemLocale} before the first screen paints.
 */
export const getLocale = (): AppLocale => state.locale;

export const setLocale = (locale: AppLocale): void => {
    if (locale === state.locale) return;
    state.locale = locale;
    notifyListeners(listeners, undefined);
};

export const subscribeLocale = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/**
 * The device's preferred language as Hermes reports it. Hermes resolves `Intl` against the Android or iOS system
 * locale, so this follows the phone's language settings without a native module.
 */
const systemLanguages = (): readonly string[] => {
    try {
        // react-doctor-disable-next-line react-doctor/js-hoist-intl -- Each call must re-read the system locale, since the app re-syncs on every return to the foreground; a hoisted formatter would freeze the startup locale.
        return [new Intl.DateTimeFormat().resolvedOptions().locale];
    } catch {
        return [];
    }
};

/**
 * Follows the system language with Desktop's rule (`resolveAppLocale`): any Chinese preference selects Simplified
 * Chinese, everything else English. Called at startup and whenever the app returns to the foreground, because the
 * reader may change the system language while Caxri is in the background.
 */
export const syncSystemLocale = (): void => {
    setLocale(resolveAppLocale(null, systemLanguages()));
};
