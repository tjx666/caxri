import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_FILE,
    DEFAULT_FOLDER,
    getIconForFile,
    getIconForFolder,
} from '@yutengjing/vscode-icons';

import { formatSource } from '../../../scripts/format-source';
import {
    compressIconSvg,
    resolveIconSvgSource,
    restoreLeadingZeros,
    selectIconsWithinBudget,
} from './file-icon-budget';

/**
 * Desktop ships all ~1,550 vscode-icons SVGs (8 MB) as static files. A phone bundle cannot carry that, so this script
 * resolves a curated set of common names through the same lookup Desktop uses and embeds only the SVGs they reach.
 * Anything outside the set falls back to the default file or folder icon at runtime. Mobile navigates into folders
 * instead of expanding them in place, so only closed-folder icons are embedded.
 */
const EXTENSIONS = [
    'astro',
    'bash',
    'bat',
    'bmp',
    'c',
    'cc',
    'cjs',
    'conf',
    'cpp',
    'cs',
    'css',
    'csv',
    'cts',
    'd.ts',
    'dart',
    'db',
    'diff',
    'dll',
    'docx',
    'env',
    'erb',
    'ex',
    'exe',
    'exs',
    'fish',
    'gif',
    'go',
    'gql',
    'gradle',
    'graphql',
    'gz',
    'h',
    'hbs',
    'hpp',
    'htm',
    'html',
    'ico',
    'ini',
    'ipynb',
    'jar',
    'java',
    'jpeg',
    'jpg',
    'js',
    'json',
    'json5',
    'jsonc',
    'jsonl',
    'jsx',
    'kt',
    'kts',
    'less',
    'lock',
    'log',
    'lua',
    'm',
    'md',
    'mdx',
    'mjs',
    'mm',
    'mov',
    'mp3',
    'mp4',
    'mts',
    'nix',
    'ogg',
    'patch',
    'pdf',
    'php',
    'pl',
    'plist',
    'png',
    'ps1',
    'proto',
    'py',
    'pyi',
    'r',
    'rb',
    'rs',
    'sass',
    'scala',
    'scss',
    'sh',
    'spec.js',
    'spec.ts',
    'sql',
    'sqlite',
    'svelte',
    'svg',
    'swift',
    'tar',
    'test.js',
    'test.jsx',
    'test.ts',
    'test.tsx',
    'tf',
    'tgz',
    'toml',
    'ts',
    'tsbuildinfo',
    'tsx',
    'ttf',
    'txt',
    'vue',
    'wasm',
    'wav',
    'webm',
    'webp',
    'woff',
    'woff2',
    'xcconfig',
    'xls',
    'xlsx',
    'xml',
    'yaml',
    'yml',
    'zig',
    'zip',
    'zsh',
];

const FILE_NAMES = [
    '.babelrc',
    '.browserslistrc',
    '.dockerignore',
    '.editorconfig',
    '.env',
    '.env.example',
    '.env.local',
    '.eslintignore',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    '.gitattributes',
    '.gitignore',
    '.gitmodules',
    '.mise.toml',
    '.node-version',
    '.npmignore',
    '.npmrc',
    '.nvmrc',
    '.prettierignore',
    '.prettierrc',
    '.prettierrc.json',
    '.stylelintrc',
    '.tool-versions',
    'agents.md',
    'app.config.ts',
    'app.json',
    'babel.config.js',
    'biome.json',
    'bun.lock',
    'bun.lockb',
    'bunfig.toml',
    'cargo.lock',
    'cargo.toml',
    'changelog.md',
    'claude.md',
    'contributing.md',
    'docker-compose.yml',
    'dockerfile',
    'electron-builder.yml',
    'electron.vite.config.ts',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.ts',
    'gemfile',
    'go.mod',
    'go.sum',
    'justfile',
    'license',
    'license.md',
    'makefile',
    'metro.config.js',
    'mise.toml',
    'next.config.js',
    'next.config.mjs',
    'next.config.ts',
    'package-lock.json',
    'package.json',
    'playwright.config.ts',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'postcss.config.js',
    'postcss.config.mjs',
    'prettier.config.js',
    'pyproject.toml',
    'readme.md',
    'requirements.txt',
    'tailwind.config.js',
    'tailwind.config.ts',
    'tsconfig.json',
    'turbo.json',
    'uv.lock',
    'vercel.json',
    'vite.config.js',
    'vite.config.ts',
    'vitest.config.ts',
    'webpack.config.js',
    'yarn.lock',
];

const FOLDER_NAMES = [
    '.agents',
    '.cargo',
    '.circleci',
    '.claude',
    '.devcontainer',
    '.git',
    '.github',
    '.githooks',
    '.husky',
    '.idea',
    '.next',
    '.storybook',
    '.vscode',
    '__tests__',
    'android',
    'api',
    'app',
    'apps',
    'assets',
    'bin',
    'build',
    'components',
    'config',
    'coverage',
    'db',
    'dist',
    'docs',
    'e2e',
    'examples',
    'fixtures',
    'fonts',
    'hooks',
    'i18n',
    'icons',
    'images',
    'include',
    'ios',
    'lib',
    'locales',
    'logs',
    'middleware',
    'migrations',
    'mocks',
    'models',
    'node_modules',
    'out',
    'packages',
    'pages',
    'plugins',
    'public',
    'routes',
    'scripts',
    'server',
    'services',
    'src',
    'static',
    'store',
    'styles',
    'target',
    'temp',
    'templates',
    'test',
    'tests',
    'theme',
    'tmp',
    'tools',
    'types',
    'utils',
    'vendor',
    'views',
];

const require = createRequire(import.meta.url);
const iconsDirectory = join(
    dirname(require.resolve('@yutengjing/vscode-icons/assets/manifest.json')),
    'icons',
);
/**
 * A few curated icons stay over budget even after svgo (an embedded raster, or dozens of isometric-shading paths).
 * Those names are hand-simplified here instead, redrawn to stay visually recognizable at file-tree size. Everything
 * else loads straight from the vendored `@yutengjing/vscode-icons` package.
 */
const overridesDirectory = fileURLToPath(new URL('file-icon-overrides/', import.meta.url));
const destination = fileURLToPath(
    new URL('../src/features/panels/file-icons.generated.ts', import.meta.url),
);

const sorted = (entries: Array<[string, string]>): Record<string, string> =>
    Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));

/**
 * A handful of upstream icons embed raster art or long paths (the PDF icon alone is 42 KB). Past this budget the
 * default icon is a better trade than bundle weight.
 */
const MAX_ICON_BYTES = 8 * 1_024;

const minify = (svg: string): string =>
    svg
        .replaceAll(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/gu, '')
        .replaceAll(/>\s+</gu, '><')
        .replaceAll(/\s{2,}/gu, ' ')
        .trim();

const svgSources = new Map<string, string>();
const loadSvg = async (file: string): Promise<string> => {
    const cached = svgSources.get(file);
    if (cached !== undefined) return cached;
    const raw = await resolveIconSvgSource(
        file,
        (name) => readFile(join(overridesDirectory, name), 'utf8'),
        (name) => readFile(join(iconsDirectory, name), 'utf8'),
    );
    const svg = restoreLeadingZeros(minify(compressIconSvg(raw, file)));
    svgSources.set(file, svg);
    return svg;
};

/**
 * Names dropped for exceeding `MAX_ICON_BYTES`, reported at the end of the run so a maintainer can see, without
 * re-deriving it, which common types are worth hand-authoring a slim replacement for (see the summary printed below).
 */
const oversizeIcons: Array<{ bytes: number; icon: string; name: string }> = [];

/**
 * Keep only names that resolve to a specific, embeddable icon; a name that resolves to the default adds nothing over
 * the fallback. An icon over budget is recorded in `oversizeIcons` instead of silently dropped, so its cost stays
 * visible in the build log.
 */
const keep = async (
    entries: Array<[string, string | undefined]>,
    fallback: string,
): Promise<Record<string, string>> => {
    const { kept, oversize } = await selectIconsWithinBudget(
        entries,
        fallback,
        MAX_ICON_BYTES,
        async (icon) => Buffer.byteLength(await loadSvg(icon)),
    );
    oversizeIcons.push(...oversize);
    return sorted([...kept]);
};

const fileExtensions = await keep(
    EXTENSIONS.map((extension) => [extension, getIconForFile(`file.${extension}`)]),
    DEFAULT_FILE,
);
const fileNames = await keep(
    FILE_NAMES.map((name) => [name, getIconForFile(name)]),
    DEFAULT_FILE,
);
const folderNames = await keep(
    FOLDER_NAMES.map((name) => [name, getIconForFolder(name)]),
    DEFAULT_FOLDER,
);

const iconFiles = new Set([
    DEFAULT_FILE,
    DEFAULT_FOLDER,
    'folder_type_git.svg',
    ...Object.values(fileExtensions),
    ...Object.values(fileNames),
    ...Object.values(folderNames),
]);
const svgs = sorted(
    await Promise.all(
        [...iconFiles].map(
            async (file) => [file.replace(/\.svg$/u, ''), await loadSvg(file)] as [string, string],
        ),
    ),
);
const id = (file: string): string => file.replace(/\.svg$/u, '');
const idMap = (record: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).map(([key, file]) => [key, id(file)]));

const source = `/**
 * Generated by apps/mobile/scripts/build-file-icons.ts from \`@yutengjing/vscode-icons\`. Do not edit by hand; run \`bun
 * run --cwd apps/mobile build:file-icons\` after changing the curated name lists.
 */
export const FILE_ICON_DEFAULTS = ${JSON.stringify({
    file: id(DEFAULT_FILE),
    folder: id(DEFAULT_FOLDER),
    repository: 'folder_type_git',
})} as const;
export const FILE_ICON_EXTENSIONS: Readonly<Record<string, string>> = ${JSON.stringify(idMap(fileExtensions))};
export const FILE_ICON_NAMES: Readonly<Record<string, string>> = ${JSON.stringify(idMap(fileNames))};
export const FOLDER_ICON_NAMES: Readonly<Record<string, string>> = ${JSON.stringify(idMap(folderNames))};
export const FILE_ICON_SVGS: Readonly<Record<string, string>> = ${JSON.stringify(svgs)};
`;
await writeFile(destination, await formatSource(source, destination));
console.log(`${iconFiles.size} icons, ${Buffer.byteLength(source)} bytes`);

if (oversizeIcons.length > 0) {
    const byIcon = new Map<string, { bytes: number; names: string[] }>();
    for (const { bytes, icon, name } of oversizeIcons) {
        const existing = byIcon.get(icon);
        if (existing) existing.names.push(name);
        else byIcon.set(icon, { bytes, names: [name] });
    }
    const budget = `${MAX_ICON_BYTES / 1_024} KB`;
    console.error(
        `ERROR: ${byIcon.size} icon(s) exceed the ${budget} budget after svgo compression and fell back to the ` +
            `default icon (largest first). Compression and the file-icon-overrides/ replacements are expected to ` +
            `cover every curated name; add or update an override for each icon below instead of accepting the ` +
            `fallback silently.`,
    );
    const byIconDescending = [...byIcon].toSorted((left, right) => right[1].bytes - left[1].bytes);
    for (const [icon, { bytes, names }] of byIconDescending) {
        console.error(`  ${icon}: ${Math.round(bytes / 1_024)} KB (${names.join(', ')})`);
    }
    // Fail the build loudly instead of shipping a silent icon regression; the generated file above is still written
    // so the app keeps working with the default-icon fallback while a maintainer fixes the oversized entry.
    process.exitCode = 1;
}
