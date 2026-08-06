import { describe, expect, it } from 'vitest';

import { resolveFileIcon } from './file-icon-resolver';

describe('resolveFileIcon', () => {
    it.each([
        ['package.json', 'nodejs'],
        ['vite.config.ts', 'vite'],
        ['Component.tsx', 'reactTypeScript'],
        ['Component.test.tsx', 'testTypeScript'],
        ['types.d.ts', 'typescriptDefinition'],
        ['README.md', 'readme'],
        ['diagram.svg', 'svg'],
        ['unknown', 'file'],
    ])('resolves %s to %s', (name, id) => {
        expect(resolveFileIcon({ kind: 'file', name }).id).toBe(id);
    });

    it.each([
        ['.github', 'folder-github'],
        ['.vscode', 'folder-vscode'],
        ['src', 'folder-src'],
        ['public', 'folder-public'],
        ['node_modules', 'folder-node'],
        ['unknown', 'folder-generic'],
    ])('resolves the %s directory to %s', (name, id) => {
        expect(resolveFileIcon({ kind: 'directory', name }).id).toBe(id);
    });

    it('uses the matching open-directory asset without changing the mapping', () => {
        const icon = resolveFileIcon({ kind: 'directory', name: '.github' }, true);
        expect(icon.id).toBe('folder-github-open');
        expect(icon.src).toContain('folder-github-open');
    });

    it('uses the generic file fallback for symlinks', () => {
        expect(resolveFileIcon({ kind: 'symlink', name: 'current' }).id).toBe('file');
    });
});
