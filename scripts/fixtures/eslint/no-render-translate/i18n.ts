/** Stand-in for the Renderer i18n module so the fixture stays out of the Renderer project. */
export type Translate = (key: string) => string;

export function translate(key: string): string {
    return key;
}

export function useTranslation(): { t: typeof translate } {
    return { t: translate };
}
