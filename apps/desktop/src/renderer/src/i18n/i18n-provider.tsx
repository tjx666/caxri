import type { ReactNode } from 'react';
import { useEffect } from 'react';

import ConfigProvider from '@lobehub/ui/es/ConfigProvider/index';
import * as m from 'motion/react-m';

import { useLocaleStore } from './locale-store';
import { lobeResources } from './resources';

/**
 * `@lobehub/ui`'s `I18nProvider` always installs the library's global focus ring, which rewrites every focus-visible
 * outline with `!important` and would replace Caxri's own focus treatment. Its `ConfigProvider` owns the same i18n
 * context and lets that side effect be switched off.
 */
const LOBE_CONFIG = { globalFocusRing: false } as const;

/**
 * Supplies the active locale from `useLocaleStore` to `useTranslation()`, plus `<html lang>` so the platform (spell
 * check, hyphenation, screen readers) agrees with the rendered text.
 *
 * The locale store is the only source, so `useTranslation()` and `translate()` never disagree within one render.
 * Windows that load Settings keep it in step with `syncWorkbenchLocale()`.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
    const locale = useLocaleStore((state) => state.locale);
    useEffect(() => {
        document.documentElement.lang = locale;
    }, [locale]);
    return (
        <ConfigProvider
            config={LOBE_CONFIG}
            locale={locale}
            // Required by the library for its animated components. Caxri renders none of them, so the tree-shakable
            // `m` variant is enough and keeps the full `motion` bundle out.
            motion={m}
            resources={lobeResources[locale]}
        >
            {children}
        </ConfigProvider>
    );
}
