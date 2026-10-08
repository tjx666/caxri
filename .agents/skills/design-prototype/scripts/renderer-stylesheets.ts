import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Reads every Renderer stylesheet `styles.css` imports, keyed by the exact specifier it imports them under, ready to
 * hand to `inlineThemeCss`.
 *
 * The set is discovered from the file rather than listed by hand, so adding a Renderer stylesheet needs no change here.
 * The hand-written list this replaced lived in two places (the build script and its test) and a new `@import` failed
 * the test even after the script had been taught about it.
 *
 * Only relative specifiers are collected: a package import has no path to read, and `inlineThemeCss`'s leftover guard
 * is what reports one.
 */
export async function readImportedCss(
    stylesDirectory: string,
    stylesCss: string,
): Promise<Record<string, string>> {
    const specifiers = stylesCss
        .matchAll(/@import\s+(['"])(\.\/[^'"]+)\1;/g)
        .map((match) => match[2])
        // `theme.css` leads the payload as its own argument, so inlining it here would emit it a second time.
        .filter((specifier) => specifier !== './theme.css')
        .toArray();
    const entries = await Promise.all(
        specifiers.map(
            async (specifier) =>
                [specifier, await readFile(path.join(stylesDirectory, specifier), 'utf8')] as const,
        ),
    );
    return Object.fromEntries(entries);
}
