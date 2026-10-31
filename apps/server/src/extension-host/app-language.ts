import type { AppLocale } from '@caxri/protocol';
import type { CaxriEnvironment, L10n } from 'caxri';
import { createL10n, EventEmitter } from 'caxri';

import type { ExtensionHostRegistration } from './protocol';

/**
 * The app language every binding reads through `env.language` and `l10n.t`. Server Core sets it on `configure` and
 * `languageChanged`, so an imported `l10n` translates into the current language at call time.
 */
const appLanguage: { locale: AppLocale } = { locale: 'en' };

export function setAppLanguage(locale: AppLocale): void {
    appLanguage.locale = locale;
}

/**
 * One extension's `env` and `l10n`, plus the trigger for its `onDidChangeLanguage`.
 */
export function createLanguageApi(registration: Pick<ExtensionHostRegistration, 'l10n'>): {
    env: CaxriEnvironment;
    l10n: L10n;
    notify(locale: AppLocale): void;
} {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    const changed = new EventEmitter<string>();
    return {
        env: Object.freeze({
            get language() {
                return appLanguage.locale;
            },
            onDidChangeLanguage: changed.event,
        }),
        l10n: createL10n(() => registration.l10n[appLanguage.locale]),
        notify: (locale) => changed.fire(locale),
    };
}
