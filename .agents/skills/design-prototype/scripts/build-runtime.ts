/**
 * Build the design-prototype runtime so prototypes are single HTML files that run offline over `file://` with the REAL
 * Caxri design system. Outputs:
 *
 * - `caxri-prototype-runtime.js`: react + `@/components/ui/*` + lucide-react + … (IIFE)
 * - `caxri-prototype-theme.js`: theme.css + styles.css + tw-animate-css inlined as `window.__CAXRI_THEME_CSS__`
 * - `tailwind-browser.js`: vendored `@tailwindcss/browser` (pinned to the repo's tailwindcss version)
 * - `babel.min.js`: vendored babel-standalone for in-browser JSX/TSX
 *
 * Usage: `bun run .agents/skills/design-prototype/scripts/build-runtime.ts [out-dir]`. Default out-dir:
 * `<skill>/assets` (built artifacts are gitignored). Rebuilds are always safe (~2s); the two vendored files cache under
 * `assets/` by exact version, so only the first build per machine needs network access.
 */
import { Buffer } from 'node:buffer';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { inlineThemeCss } from './inline-theme-css';
import { readImportedCss } from './renderer-stylesheets';

const skillDirectory = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(skillDirectory, '../../..');
const outDirectory = path.resolve(process.argv[2] ?? path.join(skillDirectory, 'assets'));
await mkdir(outDirectory, { recursive: true });

async function isNonEmptyFile(filePath: string): Promise<boolean> {
    try {
        return (await stat(filePath)).size > 0;
    } catch {
        return false;
    }
}

/**
 * Esbuild ships as a transitive dependency (vite); pick the newest copy in the pnpm store.
 */
async function resolveEsbuild(): Promise<string> {
    const store = path.join(repoRoot, 'node_modules/.pnpm');
    let entries: string[];
    try {
        entries = await readdir(store);
    } catch {
        throw new Error(`pnpm store not found at ${store}: run \`ni\` first`);
    }
    const copies = entries
        .filter((name) => /^esbuild@\d/.test(name))
        .toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const newest = copies.at(-1);
    if (!newest) throw new Error('esbuild not found in the pnpm store: run `ni` first');
    return path.join(store, newest, 'node_modules/esbuild/bin/esbuild');
}

async function buildRuntime(): Promise<void> {
    const esbuild = await resolveEsbuild();
    await execFileAsync(
        esbuild,
        [
            path.join(skillDirectory, 'assets/entry.mjs'),
            '--bundle',
            '--format=iife',
            '--global-name=__CAXRI_PROTO_NS__',
            '--platform=browser',
            '--define:process.env.NODE_ENV="production"',
            '--minify',
            // Renderer .tsx compiles with the automatic JSX runtime (no React imports).
            '--jsx=automatic',
            '--loader:.css=empty',
            '--loader:.woff=dataurl',
            '--loader:.woff2=dataurl',
            '--loader:.svg=dataurl',
            '--loader:.png=dataurl',
            `--alias:@=${path.join(repoRoot, 'apps/desktop/src/renderer/src')}`,
            `--outfile=${path.join(outDirectory, 'caxri-prototype-runtime.js')}`,
        ],
        { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
    );
}

async function buildThemeScript(): Promise<void> {
    const stylesDirectory = path.join(repoRoot, 'apps/desktop/src/renderer/src/styles');
    const stylesCss = await readFile(path.join(stylesDirectory, 'styles.css'), 'utf8');
    const css = inlineThemeCss({
        themeCss: await readFile(path.join(stylesDirectory, 'theme.css'), 'utf8'),
        twAnimateCss: await readFile(
            path.join(repoRoot, 'node_modules/tw-animate-css/dist/tw-animate.css'),
            'utf8',
        ),
        stylesCss,
        importedCss: await readImportedCss(stylesDirectory, stylesCss),
    });
    await writeFile(
        path.join(outDirectory, 'caxri-prototype-theme.js'),
        `window.__CAXRI_THEME_CSS__ = ${JSON.stringify(css)};\n`,
    );
}

/**
 * Download once into a version-stamped skill-local cache, then copy into the out dir under the stable name the template
 * references. The version lives in the cache file name so a dependency bump can never silently reuse a stale download.
 */
async function vendor(url: string, cacheFileName: string, outFileName: string): Promise<void> {
    const cached = path.join(skillDirectory, 'assets', cacheFileName);
    if (!(await isNonEmptyFile(cached))) {
        let response: Response;
        try {
            response = await fetch(url);
        } catch (error) {
            throw new Error(
                `download failed: ${url}: the first build per machine needs network access`,
                { cause: error },
            );
        }
        if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
        await writeFile(cached, Buffer.from(await response.arrayBuffer()));
    }
    const target = path.join(outDirectory, outFileName);
    await copyFile(cached, target);
}

/**
 * `@tailwindcss/browser` versions track tailwindcss releases, so the unpkg URL needs an exact version. Read it from the
 * installed package rather than the manifest range: ordinary dependencies here carry a `^` range (AGENTS.md), which
 * names no single version to download and would leave the prototype runtime unbuildable.
 */
const installedTailwind = JSON.parse(
    await readFile(path.join(repoRoot, 'node_modules/tailwindcss/package.json'), 'utf8'),
) as { version: string };
const tailwindVersion = installedTailwind.version;
if (!/^\d+\.\d+\.\d+$/.test(tailwindVersion)) {
    throw new Error(
        `node_modules/tailwindcss reports an unusable version for the @tailwindcss/browser download: ${tailwindVersion}`,
    );
}

const BABEL_STANDALONE_VERSION = '7.26.4';

await Promise.all([
    buildRuntime(),
    buildThemeScript(),
    vendor(
        `https://unpkg.com/@tailwindcss/browser@${tailwindVersion}/dist/index.global.js`,
        `tailwind-browser@${tailwindVersion}.js`,
        'tailwind-browser.js',
    ),
    vendor(
        `https://unpkg.com/@babel/standalone@${BABEL_STANDALONE_VERSION}/babel.min.js`,
        `babel-standalone@${BABEL_STANDALONE_VERSION}.min.js`,
        'babel.min.js',
    ),
]);

const outputFiles = [
    'caxri-prototype-runtime.js',
    'caxri-prototype-theme.js',
    'tailwind-browser.js',
    'babel.min.js',
];
const sizes = await Promise.all(
    outputFiles.map(async (file) => (await stat(path.join(outDirectory, file))).size),
);
for (const [index, file] of outputFiles.entries()) {
    console.log(`${(sizes[index] / 1024 / 1024).toFixed(1)}MB  ${file}`);
}
console.log(`done → ${outDirectory}`);
