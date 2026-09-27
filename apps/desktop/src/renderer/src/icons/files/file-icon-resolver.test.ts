import { describe, expect, it } from 'vitest';

import { resolveFileIcon } from './file-icon-resolver';

describe('resolveFileIcon', () => {
    it.each([
        ['package.json', 'file_type_npm'],
        ['vite.config.ts', 'file_type_vite'],
        ['Component.tsx', 'file_type_reactts'],
        ['Component.test.tsx', 'file_type_testts'],
        ['types.d.ts', 'file_type_typescriptdef'],
        ['README.md', 'file_type_markdown'],
        ['diagram.svg', 'file_type_svg'],
        ['unknown', 'default_file'],
    ])('resolves %s to %s', (name, id) => {
        expect(resolveFileIcon({ kind: 'file', name }).id).toBe(id);
    });

    it.each([
        ['.github', 'folder_type_github'],
        ['.vscode', 'folder_type_vscode'],
        ['src', 'folder_type_src'],
        ['public', 'folder_type_public'],
        ['node_modules', 'folder_type_node'],
        ['unknown', 'default_folder'],
    ])('resolves the %s directory to %s', (name, id) => {
        expect(resolveFileIcon({ kind: 'directory', name }).id).toBe(id);
    });

    it('uses the matching open-directory asset without changing the mapping', () => {
        const icon = resolveFileIcon({ kind: 'directory', name: '.github' }, true);
        expect(icon.id).toBe('folder_type_github_opened');
        expect(icon.src).toContain('folder_type_github_opened');
    });

    it('resolves case-sensitive vscode-icons file names exactly', () => {
        expect(resolveFileIcon({ kind: 'file', name: 'BUILD.bazel' }).id).toBe('file_type_bazel');
        expect(resolveFileIcon({ kind: 'file', name: 'Vagrantfile' }).id).toBe('file_type_vagrant');
    });

    it('resolves extensionless filenames through the package filename-language bridge', () => {
        expect(resolveFileIcon({ kind: 'file', name: 'Jenkinsfile' }).id).toBe('file_type_groovy');
        expect(resolveFileIcon({ kind: 'file', name: 'Dockerfile' }).id).toBe('file_type_docker');
        expect(resolveFileIcon({ kind: 'file', name: 'Makefile' }).id).toBe('file_type_gnu');
    });

    it('resolves a symlink by what it points at', () => {
        expect(resolveFileIcon({ kind: 'symlink', linkKind: 'directory', name: 'src' }).id).toBe(
            'folder_type_src',
        );
        expect(
            resolveFileIcon({ kind: 'symlink', linkKind: 'file', name: 'Component.tsx' }).id,
        ).toBe('file_type_reactts');
    });

    it('falls back to the link target when the link name carries no type of its own', () => {
        expect(
            resolveFileIcon({
                kind: 'symlink',
                linkKind: 'file',
                linkTarget: '../releases/app-2026.log',
                name: 'current',
            }).id,
        ).toBe('file_type_log');
        // The link's own name still wins when it is typed.
        expect(
            resolveFileIcon({
                kind: 'symlink',
                linkKind: 'file',
                linkTarget: '../releases/app-2026.log',
                name: 'current.ts',
            }).id,
        ).toBe('file_type_typescript');
    });

    it('keeps the neutral fallback for a broken or unresolved symlink', () => {
        expect(
            resolveFileIcon({ kind: 'symlink', linkKind: 'broken', name: 'Component.tsx' }).id,
        ).toBe('default_file');
        expect(resolveFileIcon({ kind: 'symlink', name: 'current' }).id).toBe('default_file');
    });
});
