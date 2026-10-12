/**
 * The system's preferred languages as Chromium reports them. Electron derives `navigator.languages` from the macOS
 * language list, so this follows System Settings › Language & Region without a Main round trip.
 */
export function systemLanguages(): readonly string[] {
    // Node also defines `navigator`, reporting the host's locale, so a Vitest run on a Chinese-language machine would
    // otherwise render Chinese and diverge from CI. Outside a document the system language is treated as unknown.
    if (typeof document === 'undefined') return [];
    return navigator.languages;
}
