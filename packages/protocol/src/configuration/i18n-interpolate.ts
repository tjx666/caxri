/**
 * Values substituted into `{{name}}` placeholders of a translation.
 */
export type TranslationParameters = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Replaces `{{name}}` placeholders with `params[name]`. A placeholder without a matching param is left verbatim so a
 * missing argument shows up in the UI instead of silently rendering an empty string.
 */
export function interpolate(template: string, parameters?: TranslationParameters): string {
    if (!parameters) return template;
    return template.replaceAll(PLACEHOLDER, (placeholder, name: string) =>
        Object.hasOwn(parameters, name) ? String(parameters[name]) : placeholder,
    );
}

/**
 * Shape a translated namespace must satisfy: exactly the keys of its English source module, each mapped to a string. A
 * missing or misspelled key fails type checking instead of falling back to English at runtime.
 */
export type TranslatedNamespace<Source> = { readonly [Key in keyof Source]: string };
