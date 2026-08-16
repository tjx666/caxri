import type { FileEntry } from '@shared/types';

import type { FileIconId, FolderIconId } from './file-icon-assets';
import { fileIconAssets, folderIconAssets } from './file-icon-assets';

export interface ResolvedFileIcon {
    id: string;
    src: string;
}

const folderNames = new Map<string, FolderIconId>([
    ['.devcontainer', 'container'],
    ['.git', 'git'],
    ['.githooks', 'git'],
    ['.github', 'github'],
    ['.husky', 'husky'],
    ['.next', 'next'],
    ['.vscode', 'vscode'],
    ['__tests__', 'test'],
    ['app', 'app'],
    ['apps', 'app'],
    ['assets', 'resource'],
    ['docs', 'docs'],
    ['e2e', 'test'],
    ['icons', 'resource'],
    ['images', 'resource'],
    ['locales', 'i18n'],
    ['node_modules', 'node'],
    ['packages', 'packages'],
    ['public', 'public'],
    ['scripts', 'scripts'],
    ['src', 'src'],
    ['test', 'test'],
    ['tests', 'test'],
    ['tmp', 'temp'],
]);

const exactFileNames = new Map<string, FileIconId>([
    ['.dockerignore', 'docker'],
    ['.env', 'tune'],
    ['.gitattributes', 'git'],
    ['.gitignore', 'git'],
    ['.gitmodules', 'git'],
    ['.npmignore', 'npm'],
    ['.npmrc', 'npm'],
    ['agents.md', 'markdown'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['claude.md', 'markdown'],
    ['codeowners', 'codeowners'],
    ['dockerfile', 'docker'],
    ['package-lock.json', 'npm'],
    ['package.json', 'nodejs'],
    ['pnpm-lock.yaml', 'lock'],
    ['readme.md', 'readme'],
    ['tsconfig.json', 'tsconfig'],
    ['yarn.lock', 'lock'],
]);

const filePrefixes: Array<[string, FileIconId]> = [
    ['.env.', 'tune'],
    ['commitlint.config.', 'commitlint'],
    ['eslint.config.', 'eslint'],
    ['next.config.', 'next'],
    ['playwright.config.', 'playwright'],
    ['prettier.config.', 'prettier'],
    ['stylelint.config.', 'stylelint'],
    ['vite.config.', 'vite'],
    ['vitest.config.', 'vitest'],
];

const fileExtensions = new Map<string, FileIconId>([
    ['bash', 'console'],
    ['cjs', 'javascript'],
    ['css', 'css'],
    ['cts', 'typescript'],
    ['env', 'tune'],
    ['fish', 'console'],
    ['gif', 'image'],
    ['go', 'go'],
    ['html', 'html'],
    ['ico', 'image'],
    ['jpeg', 'image'],
    ['jpg', 'image'],
    ['js', 'javascript'],
    ['json', 'json'],
    ['json5', 'json'],
    ['jsonc', 'json'],
    ['jsonl', 'json'],
    ['jsx', 'react'],
    ['less', 'less'],
    ['lock', 'lock'],
    ['log', 'log'],
    ['md', 'markdown'],
    ['mdx', 'mdx'],
    ['mjs', 'javascript'],
    ['mts', 'typescript'],
    ['pdf', 'pdf'],
    ['png', 'image'],
    ['py', 'python'],
    ['rs', 'rust'],
    ['sass', 'sass'],
    ['scss', 'sass'],
    ['sh', 'console'],
    ['sql', 'database'],
    ['svg', 'svg'],
    ['ts', 'typescript'],
    ['tsx', 'reactTypeScript'],
    ['txt', 'document'],
    ['webp', 'image'],
    ['xml', 'xml'],
    ['yaml', 'yaml'],
    ['yml', 'yaml'],
    ['zip', 'zip'],
    ['zsh', 'console'],
]);

function resolveFileId(name: string): FileIconId {
    const lowerName = name.toLowerCase();
    const exact = exactFileNames.get(lowerName);
    if (exact) return exact;
    const prefixed = filePrefixes.find(([prefix]) => lowerName.startsWith(prefix));
    if (prefixed) return prefixed[1];
    if (lowerName.endsWith('.d.ts')) return 'typescriptDefinition';
    if (/\.(?:test|spec)\.tsx?$/.test(lowerName)) return 'testTypeScript';
    if (/\.(?:test|spec)\.jsx$/.test(lowerName)) return 'testJsx';
    if (/\.(?:test|spec)\.js$/.test(lowerName)) return 'testJavaScript';
    const extension = lowerName.includes('.') ? lowerName.split('.').at(-1) : undefined;
    return (extension && fileExtensions.get(extension)) || 'file';
}

export function resolveFileIcon(
    entry: Pick<FileEntry, 'kind' | 'name'>,
    isExpanded = false,
): ResolvedFileIcon {
    if (entry.kind === 'directory') {
        const id = folderNames.get(entry.name.toLowerCase()) ?? 'generic';
        return {
            id: `folder-${id}${isExpanded ? '-open' : ''}`,
            src: folderIconAssets[id][isExpanded ? 'open' : 'closed'],
        };
    }
    const id = resolveFileId(entry.name);
    return { id, src: fileIconAssets[id] };
}
