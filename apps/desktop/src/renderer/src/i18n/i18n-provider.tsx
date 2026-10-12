import type { ReactNode } from 'react';
import { useEffect } from 'react';

import type { AppLocale } from '@caxri/protocol';
import ConfigProvider from '@lobehub/ui/es/ConfigProvider/index';
import { motion } from 'motion/react';

import { resolveAppLocale, systemLanguages } from './locale';
import { useLocaleStore } from './locale-store';
import { lobeResources } from './resources';

/**
 * `@lobehub/ui`'s `I18nProvider` always installs the library's global focus ring, which rewrites every focus-visible
 * outline with `!important` and would replace Caxri's own focus treatment. Its `ConfigProvider` owns the same i18n
 * context and lets that side effect be switched off.
 */
const LOBE_CONFIG = { globalFocusRing: false } as const;

interface I18nProviderProperties {
    /**
     * The `workbench.language` setting. `null` follows the system language, and so does `undefined`: Settings not
     * loaded yet, or a window that never loads them (Process Explorer).
     */
    preference: AppLocale | null | undefined;
    children: ReactNode;
}

/**
 * Supplies the active locale to `useTranslation()` and mirrors it into the module-level store `translate()` reads, plus
 * `<html lang>` so the platform (spell check, hyphenation, screen readers) agrees with the rendered text.
 *
 * Takes the preference as a prop rather than reading the Workbench store so stores can import `translate()` from this
 * module's barrel without an import cycle.
 */
export function I18nProvider({ preference, children }: I18nProviderProperties) {
    const locale = resolveAppLocale(preference, systemLanguages());
    useEffect(() => {
        useLocaleStore.setState({ locale });
        document.documentElement.lang = locale;
    }, [locale]);
    return (
        <ConfigProvider
            config={LOBE_CONFIG}
            locale={locale}
            motion={motion}
            resources={lobeResources[locale]}
        >
            {children}
        </ConfigProvider>
    );
}
