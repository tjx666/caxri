import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    adjacentBreadcrumbPickerPath,
    editorBreadcrumbDirectoryLabel,
    editorBreadcrumbPickerDirectory,
    editorBreadcrumbSegments,
    readOnlyBreadcrumbSegments,
    typeaheadBreadcrumbPickerPath,
} from '../editor-breadcrumbs-model';

describe('editorBreadcrumbSegments', () => {
    it('builds the full Project-relative chain without exposing the absolute root', () => {
        expect(editorBreadcrumbSegments('/project/src/features/editor.ts', '/project')).toEqual([
            {
                kind: 'directory',
                label: 'src',
                path: '/project/src',
                relativePath: 'src',
            },
            {
                kind: 'directory',
                label: 'features',
                path: '/project/src/features',
                relativePath: 'src/features',
            },
            {
                kind: 'file',
                label: 'editor.ts',
                path: '/project/src/features/editor.ts',
                relativePath: 'src/features/editor.ts',
            },
        ]);
    });

    it('supports a filesystem-root Project and rejects paths outside the Project', () => {
        expect(editorBreadcrumbSegments('/project/README.md', '/project')).toEqual([
            {
                kind: 'file',
                label: 'README.md',
                path: '/project/README.md',
                relativePath: 'README.md',
            },
        ]);
        expect(editorBreadcrumbSegments('/src/editor.ts', '/')).toHaveLength(2);
        expect(editorBreadcrumbSegments('/project-other/editor.ts', '/project')).toEqual([]);
    });
});

describe('editor breadcrumb picker selection', () => {
    const entries = [
        { kind: 'directory' as const, name: 'components', path: '/project/src/components' },
        { kind: 'directory' as const, name: 'features', path: '/project/src/features' },
        { kind: 'file' as const, name: 'alpha.ts', path: '/project/src/alpha.ts' },
        { kind: 'file' as const, name: 'beta.ts', path: '/project/src/beta.ts' },
        { kind: 'symlink' as const, name: 'linked.ts', path: '/project/src/linked.ts' },
    ];

    it('moves through workspace links like other entries', () => {
        expect(adjacentBreadcrumbPickerPath(entries, undefined, 'next')).toBe(
            '/project/src/components',
        );
        expect(adjacentBreadcrumbPickerPath(entries, '/project/src/beta.ts', 'next')).toBe(
            '/project/src/linked.ts',
        );
        expect(adjacentBreadcrumbPickerPath(entries, undefined, 'last')).toBe(
            '/project/src/linked.ts',
        );
    });

    it('cycles typeahead from the active entry and matches a multi-character prefix', () => {
        expect(typeaheadBreadcrumbPickerPath(entries, undefined, 'c')).toBe(
            '/project/src/components',
        );
        expect(typeaheadBreadcrumbPickerPath(entries, '/project/src/alpha.ts', 'b')).toBe(
            '/project/src/beta.ts',
        );
        expect(typeaheadBreadcrumbPickerPath(entries, '/project/src/beta.ts', 'al')).toBe(
            '/project/src/alpha.ts',
        );
    });
});

describe('editor breadcrumb picker paths', () => {
    it('opens a segment among its siblings and labels the Project root plainly', () => {
        const [segment] = editorBreadcrumbSegments('/project/src/editor.ts', '/project');

        expect(editorBreadcrumbPickerDirectory(segment)).toBe('/project');
        expect(editorBreadcrumbDirectoryLabel('/project', '/project', translate)).toBe(
            'Project root',
        );
        expect(editorBreadcrumbDirectoryLabel('/project/src', '/project', translate)).toBe('src');
    });
});

describe('readOnlyBreadcrumbSegments', () => {
    it('keeps every ancestor of a path no Project can browse', () => {
        // A globally authorized file lives outside every Project root, so the full absolute trail is the only place the
        // Session can see where it actually is.
        expect(readOnlyBreadcrumbSegments('/etc/hosts')).toEqual([
            { label: 'etc', trail: 'etc' },
            { label: 'hosts', trail: 'etc/hosts' },
        ]);
        // A Git diff path is already repository-relative and has no leading slash to drop.
        expect(
            readOnlyBreadcrumbSegments('extensions/git/src/extension.ts').map(({ label }) => label),
        ).toEqual(['extensions', 'git', 'src', 'extension.ts']);
        // A trailing or doubled separator must not print an empty segment with its own chevron.
        expect(readOnlyBreadcrumbSegments('//tmp//scratch/').map(({ label }) => label)).toEqual([
            'tmp',
            'scratch',
        ]);
        expect(readOnlyBreadcrumbSegments('')).toEqual([]);
    });

    it('gives a repeated ancestor name its own key', () => {
        // `src/app/src` would collide on the label alone, which is what the trail prefix exists to prevent.
        expect(
            readOnlyBreadcrumbSegments('src/app/src/index.ts').map(({ trail }) => trail),
        ).toEqual(['src', 'src/app', 'src/app/src', 'src/app/src/index.ts']);
    });
});
