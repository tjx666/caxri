import type { AppLocale } from '@caxri/protocol';

const knownLocales = { 'en': true, 'zh-CN': true } satisfies Record<AppLocale, true>;

/**
 * Reads the `workbench.language` locale Main resolved when it opened Process Explorer (the `caxri-locale` query
 * parameter). Process Explorer has no Workbench snapshot, so without this it would follow the system language even when
 * the Workbench speaks another. An absent or unknown value returns `undefined`, which keeps the system language.
 */
export function processExplorerLocaleFromSearch(search: string): AppLocale | undefined {
    const value = new URLSearchParams(search).get('caxri-locale');
    return value !== null && Object.hasOwn(knownLocales, value) ? (value as AppLocale) : undefined;
}
