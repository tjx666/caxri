import type { Event } from './events.js';

/**
 * A value substituted into a localized message.
 */
export type L10nArgument = boolean | number | string;

/**
 * Runtime message translation for one extension, modeled on VS Code's `l10n.t`. The English source message is the key:
 * the Extension Host looks it up in the extension's `l10n/bundle.l10n.<locale>.json` for the app language and falls
 * back to the message itself, so an untranslated message, or an extension that ships no bundle, still reads correctly.
 */
export interface L10n {
    /**
     * Translates `message` and fills `{0}`, `{1}`, … from the positional arguments.
     */
    t(message: string, ...arguments_: L10nArgument[]): string;
    /**
     * Translates `message` and fills `{name}` placeholders from `args`.
     */
    t(message: string, arguments_: Readonly<Record<string, L10nArgument>>): string;
}

/**
 * The app's interface language as an extension sees it.
 */
export interface CaxriEnvironment {
    /**
     * The interface language the user reads, as a BCP 47 tag (`en`, `zh-CN`). It follows the `workbench.language`
     * setting, or the system language when that setting is `Follow system`.
     */
    readonly language: string;
    /**
     * Fires after `language` changes. Caxri re-reads every view and re-resolves manifest contributions on its own, so
     * an extension subscribes only to drop copy it cached in the previous language.
     */
    readonly onDidChangeLanguage: Event<string>;
}

/**
 * Translation tables keyed by English source message, as `bundle.l10n.<locale>.json` stores them.
 */
export type L10nBundle = Readonly<Record<string, string>>;

const PLACEHOLDER = /\{([^{}]+)\}/g;

/**
 * Fills `{0}` or `{name}` placeholders. A placeholder without an argument stays as written so a missing value is
 * visible rather than silently blank.
 */
export function formatL10nMessage(
    template: string,
    arguments_: readonly L10nArgument[] | Readonly<Record<string, L10nArgument>>,
): string {
    return template.replaceAll(PLACEHOLDER, (placeholder, name: string) => {
        const value = Array.isArray(arguments_)
            ? (arguments_ as readonly L10nArgument[])[Number(name)]
            : Object.hasOwn(arguments_, name)
              ? (arguments_ as Readonly<Record<string, L10nArgument>>)[name]
              : undefined;
        return value === undefined ? placeholder : String(value);
    });
}

function isNamedArguments(value: unknown): value is Readonly<Record<string, L10nArgument>> {
    return typeof value === 'object' && value !== null;
}

/**
 * Builds an {@link L10n} that reads the current bundle on every call, so a language switch takes effect without
 * replacing the object an extension already imported.
 */
export function createL10n(bundle: () => L10nBundle | undefined): L10n {
    return Object.freeze({
        t(message: string, ...rest: unknown[]): string {
            const current = bundle();
            const translated =
                current && Object.hasOwn(current, message) ? current[message] : undefined;
            const template = typeof translated === 'string' ? translated : message;
            const [first] = rest;
            const arguments_ =
                rest.length === 1 && isNamedArguments(first) ? first : (rest as L10nArgument[]);
            return formatL10nMessage(template, arguments_);
        },
    });
}
