import { useMemo, useSyncExternalStore } from 'react';

import type { AppLocale } from '@caxri/protocol';

import { getLocale, subscribeLocale } from './locale-store';
import type { Translate } from './translate';
import { translate } from './translate';

/**
 * The active locale and a `t` bound to it. Components re-render when the language changes because `t` changes identity
 * with the locale, so memoized values that depend on it recompute.
 */
export function useTranslation(): { locale: AppLocale; t: Translate } {
    const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);
    // `translate` reads the store itself; the locale dependency only gives `t` a new identity per language.
    return useMemo(
        () => ({ locale, t: (key, parameters) => translate(key, parameters) }),
        [locale],
    );
}
