/**
 * Pure inliner for the prototype theme stylesheet: merge the Renderer's `theme.css`, the `tw-animate-css` distribution,
 * and `styles.css` (with its file imports replaced by those contents) into one `text/tailwindcss` payload.
 *
 * `@tailwindcss/browser` resolves the virtual `@import 'tailwindcss'` internally, but any other `@import` is fetched,
 * and `fetch()` cannot resolve relative or package specifiers over `file://`. Guard against a future `styles.css`
 * restructure (quote style, `layer(...)`, a new import) silently shipping a broken theme by rejecting every leftover
 * import.
 */
export function inlineThemeCss(input: {
    themeCss: string;
    twAnimateCss: string;
    stylesCss: string;
    /**
     * Every other Renderer stylesheet `styles.css` pulls in, keyed by the exact relative specifier it imports
     * (`'./markdown-preview.css'`). Adding a stylesheet to the Renderer is then a map entry rather than another
     * parameter here.
     */
    importedCss?: Readonly<Record<string, string>>;
}): string {
    let stylesCss = input.stylesCss
        .replace("@import './theme.css';", '')
        .replace("@import 'tw-animate-css';", '');
    const imported = Object.entries(input.importedCss ?? {});
    for (const [specifier, contents] of imported) {
        // Replaced through a function so a `$&` or `$1` inside real CSS is inserted literally rather than expanded.
        stylesCss = stylesCss.replace(`@import '${specifier}';`, () => contents);
    }
    const css = [input.themeCss, input.twAnimateCss, stylesCss].join('\n');
    const leftovers = css
        .matchAll(/@import\s[^;]+;/g)
        .map((match) => match[0])
        .filter((statement) => !/^@import\s+(['"])tailwindcss\1;$/.test(statement))
        .toArray();
    if (leftovers.length > 0) {
        throw new Error(
            `cannot inline @import for file:// prototypes: teach inline-theme-css.ts about: ${leftovers.join(' ')}`,
        );
    }
    return css;
}
