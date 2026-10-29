import { once } from 'es-toolkit';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import { statusBar as englishStatusBar } from '../../i18n/locales/en/status-bar';
import { viewContainersExtensionText as englishExtensionText } from '../../i18n/locales/en/view-containers-extension-text';

/**
 * The bundled Git and Status extensions cannot read the interface language (the Server has no system locale, and an
 * extension is a separate process), so they send English. The Renderer translates that English at display time against
 * the `viewContainers.extensionText.*` catalog: each English value is the match source, and `{{name}}` placeholders
 * match the extension's templated sentences. This is the `vscode.l10n` model: the English sentence is the key, so an
 * extension needs no per-string ids. Anything that matches no entry (a branch name, a commit subject, a third-party
 * extension's copy) passes through unchanged, so only the extension's own chrome is ever rewritten.
 */
interface ExtensionTextEntry {
    key: TranslationKey;
    names: readonly string[];
    pattern: RegExp;
}

/**
 * Placeholders that only ever hold a number match digits alone, so a count cannot swallow a neighbouring part of a
 * composed hover sentence (`main, 2 ahead`).
 */
const NUMERIC_PLACEHOLDERS: ReadonlySet<string> = new Set(['count', 'number', 'shown', 'total']);

/**
 * Placeholders that only ever hold one of the Server's provider names match that closed set, so a templated sentence
 * such as `{{provider}} failed` cannot swallow an unrelated row (a check or branch that happens to end in "failed").
 * `provider` is the CLI's display name and `service` is the service behind it; both stay English proper nouns.
 */
const PROVIDER_PLACEHOLDERS: Readonly<Record<string, string>> = {
    provider: 'GitHub CLI|LobeHub CLI|Linear CLI|Vercel CLI',
    service: 'GitHub|LobeHub|Linear|Vercel',
};

/**
 * The status bar's acceptance lifecycle and verdict words. The Status extension spells the same words, so they join the
 * lookup instead of being copied into the extension catalog a second time.
 */
const SHARED_ENGLISH_ENTRIES: ReadonlyArray<readonly [string, string]> = Object.entries(
    englishStatusBar,
).filter(
    ([key]) =>
        key.startsWith('statusBar.acceptance.status.') ||
        key.startsWith('statusBar.acceptance.verdict.'),
);

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

function escapeRegExp(value: string): string {
    return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

function compileEntry(key: TranslationKey, template: string): ExtensionTextEntry {
    const names: string[] = [];
    let source = '';
    let cursor = 0;
    for (const match of template.matchAll(PLACEHOLDER)) {
        source += escapeRegExp(template.slice(cursor, match.index));
        source += NUMERIC_PLACEHOLDERS.has(match[1])
            ? String.raw`(\d+)`
            : match[1] in PROVIDER_PLACEHOLDERS
              ? `(${PROVIDER_PLACEHOLDERS[match[1]]})`
              : String.raw`([\s\S]+?)`;
        names.push(match[1]);
        cursor = match.index + match[0].length;
    }
    source += escapeRegExp(template.slice(cursor));
    return { key, names, pattern: new RegExp(`^${source}$`) };
}

interface ExtensionTextIndex {
    exact: ReadonlyMap<string, TranslationKey>;
    /**
     * Templates with more literal text first, so `Sync Changes in {{name}}` wins over a looser sentence that could also
     * match the same string.
     */
    templates: readonly ExtensionTextEntry[];
}

function buildTextIndex(): ExtensionTextIndex {
    const exact = new Map<string, TranslationKey>();
    const templates: ExtensionTextEntry[] = [];
    for (const [key, template] of [
        ...Object.entries(englishExtensionText),
        ...SHARED_ENGLISH_ENTRIES,
    ]) {
        if (template.includes('{{')) templates.push(compileEntry(key as TranslationKey, template));
        else exact.set(template, key as TranslationKey);
    }
    const literalLength = (entry: ExtensionTextEntry) =>
        entry.pattern.source.replaceAll(/\([^)]*\)/g, '').length;
    templates.sort((left, right) => literalLength(right) - literalLength(left));
    return { exact, templates };
}

const textIndex = once(buildTextIndex);

/**
 * The entry that translates `text`, or `undefined` when it is not extension chrome.
 */
export function extensionTextKey(text: string): TranslationKey | undefined {
    const { exact, templates } = textIndex();
    return exact.get(text) ?? templates.find((entry) => entry.pattern.test(text))?.key;
}

/**
 * Translates one extension sentence; returns it unchanged when no catalog entry matches.
 */
export function localizeExtensionText(text: string, t: Translate = translate): string {
    const { exact, templates } = textIndex();
    const exactKey = exact.get(text);
    if (exactKey) return t(exactKey);
    for (const entry of templates) {
        const match = entry.pattern.exec(text);
        if (!match) continue;
        const parameters: Record<string, string> = {};
        for (const [index, name] of entry.names.entries()) parameters[name] = match[index + 1];
        return t(entry.key, parameters);
    }
    return text;
}

/**
 * Translates a hover sentence the extension composed from several parts (`main · tracking origin/main · 2 ahead`). The
 * whole string is tried first; otherwise each part is. A part that matches nothing (the branch name) stays as sent.
 */
export function localizeExtensionParts(text: string, t: Translate = translate): string {
    const whole = localizeExtensionText(text, t);
    if (whole !== text) return whole;
    return text
        .split(' · ')
        .map((part) => {
            const translated = localizeExtensionText(part, t);
            if (translated !== part) return translated;
            return part
                .split(', ')
                .map((piece) => localizeExtensionText(piece, t))
                .join(', ');
        })
        .join(' · ');
}
