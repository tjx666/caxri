/**
 * Captures the running Caxri window's current DOM as a static starting point for a prototype, so a rebuilt surface
 * copies today's markup and classes instead of an Agent's memory of them. A hand-written workbench template would go
 * stale with every UI change; a capture is always current.
 *
 * Usage: `bun run .agents/skills/design-prototype/scripts/capture-surface.ts <prototype-dir> [--port <cdp port>]
 * [--selector <css>] [--keep-text]`. The port defaults to the installed app's 9224; pass a `switch-worktree dev`
 * instance's port to capture a dev build. It writes `<prototype-dir>/surface.html`, which renders through the same
 * runtime theme as a prototype once `build-runtime.ts` has filled that directory.
 *
 * Text, labels, titles, and image sources are masked by default: the window shows the user's own Sessions, file names,
 * and transcripts. `--keep-text` keeps them for a capture that never leaves the machine.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { chromium } from 'playwright';

/**
 * Same-length placeholder that keeps line breaks and widths close to the original: CJK becomes `文`, letters `x`/`X`,
 * digits `0`, and whitespace and punctuation stay.
 */
export function maskText(text: string): string {
    return text
        .replaceAll(/\p{Script=Han}/gu, '文')
        .replaceAll(/\p{Lu}/gu, 'X')
        .replaceAll(/\p{Ll}/gu, 'x')
        .replaceAll(/\p{Nd}/gu, '0');
}

/**
 * Wraps captured markup in a page that loads the prototype runtime's theme and Tailwind compiler from the same
 * directory, so the classes render with the real tokens.
 */
export function surfaceDocument(markup: string, source: string): string {
    return `<!doctype html>
<html>
    <head>
        <meta charset="utf-8" />
        <title>Captured surface</title>
        <!-- Captured from ${source}. Starting point only: copy the structure into a prototype. -->
        <script src="./caxri-prototype-theme.js"></script>
        <script>
            const themeStyle = document.createElement('style');
            themeStyle.type = 'text/tailwindcss';
            themeStyle.textContent = window.__CAXRI_THEME_CSS__;
            document.head.append(themeStyle);
        </script>
        <script src="./tailwind-browser.js"></script>
    </head>
    <body>
${markup}
    </body>
</html>
`;
}

/**
 * Runs in the page: clones the visible target, drops kept-alive hidden Session subtrees and scripts, and masks text and
 * identifying attributes. Serialized with `toString` together with `maskText`, so it may use only browser globals and
 * its arguments.
 */
function captureInPage(
    mask: (text: string) => string,
    { selector, keepText }: { selector: string; keepText: boolean },
): string {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`no element matches ${selector}`);
    const clone = target.cloneNode(true) as Element;
    for (const element of clone.querySelectorAll(
        '[hidden], script, style, [style*="content-visibility: hidden"]',
    ))
        element.remove();
    // App-bundled images resolve inside the app archive, which a file:// page cannot load: keep each one's box only.
    for (const image of clone.querySelectorAll('img'))
        image.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=');
    if (keepText) return clone.outerHTML;
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        node.textContent = mask(node.textContent ?? '');
    for (const element of [clone, ...clone.querySelectorAll('*')]) {
        for (const name of [
            'aria-label',
            'title',
            'alt',
            'placeholder',
            'value',
            'aria-describedby',
        ])
            if (element.hasAttribute(name))
                element.setAttribute(name, mask(element.getAttribute(name) ?? ''));
        for (const name of ['href', 'data-row-id', 'data-session-id', 'id'])
            element.removeAttribute(name);
    }
    return clone.outerHTML;
}

if (import.meta.main) {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            'port': { type: 'string', default: '9224' },
            'selector': { type: 'string', default: '#root' },
            'keep-text': { type: 'boolean', default: false },
        },
    });
    const directory = positionals.at(0);
    if (!directory) {
        console.error(
            'usage: bun run .agents/skills/design-prototype/scripts/capture-surface.ts <prototype-dir> [--port <cdp port>] [--selector <css>] [--keep-text]',
        );
        process.exit(1);
    }
    const endpoint = `http://127.0.0.1:${values.port}`;
    const browser = await chromium.connectOverCDP(endpoint);
    try {
        const pages = browser.contexts().flatMap((context) => context.pages());
        const page = pages.find((candidate) => !candidate.url().startsWith('devtools://'));
        if (!page) throw new Error(`no Caxri window at ${endpoint}`);
        const options = { selector: values.selector, keepText: values['keep-text'] };
        const markup = (await page.evaluate(
            `(${captureInPage.toString()})(${maskText.toString()}, ${JSON.stringify(options)})`,
        )) as string;
        const outputDirectory = path.resolve(directory);
        await mkdir(outputDirectory, { recursive: true });
        const output = path.join(outputDirectory, 'surface.html');
        await writeFile(output, surfaceDocument(markup, `CDP port ${values.port}`));
        console.log(output);
    } finally {
        // Disconnects without closing the app: a CDP-attached browser's close only detaches.
        await browser.close();
    }
}
