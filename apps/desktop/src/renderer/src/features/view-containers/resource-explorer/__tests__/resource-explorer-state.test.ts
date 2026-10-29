import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import { controlledViewQueryKey } from '../../view-operation-client';
import type { PendingFileOperation } from '../file-operation-state';
import {
    fileOperationsForProject,
    fileTreeRootCaption,
    fileTreeRowDescription,
    fileTreeRowTooltip,
    isFileTreeDirectory,
    knownDirectoryChildrenFromQueries,
    paneTabFilePath,
    scopedValue,
    setScopedPathExpanded,
    setScopedSubtreeExpanded,
    setScopedValue,
    symlinkRowDescription,
} from '../resource-explorer-state';

describe('Resource Explorer state', () => {
    it('keeps an expanded symlink directory navigable when its type probe omitted metadata', () => {
        const entry = { kind: 'symlink' as const };

        expect(isFileTreeDirectory(entry, undefined, false)).toBe(false);
        expect(isFileTreeDirectory(entry, undefined, true)).toBe(true);
        expect(isFileTreeDirectory(entry, 'directory', false)).toBe(true);
        expect(isFileTreeDirectory({ ...entry, linkKind: 'file' }, undefined, true)).toBe(false);
    });

    it('keeps selection, focus, and editing state isolated by Session scope', () => {
        const initial = { 'session-a:project-a': '/project-a/src' };
        const updated = setScopedValue(initial, 'session-b:project-b', '/project-b/docs');

        expect(scopedValue(updated, 'session-a:project-a')).toBe('/project-a/src');
        expect(scopedValue(updated, 'session-b:project-b')).toBe('/project-b/docs');
        expect(initial).toEqual({ 'session-a:project-a': '/project-a/src' });
    });

    it('updates expansion without changing another Session scope', () => {
        const initial = {
            'session-a:project-a': ['/project-a/src'],
            'session-b:project-b': ['/project-b/docs'],
        };
        const expanded = setScopedPathExpanded(
            initial,
            'session-a:project-a',
            '/project-a/test',
            true,
        );
        const collapsed = setScopedPathExpanded(
            expanded,
            'session-a:project-a',
            '/project-a/src',
            (current) => !current,
        );

        expect(collapsed).toEqual({
            'session-a:project-a': ['/project-a/test'],
            'session-b:project-b': ['/project-b/docs'],
        });
        expect(initial['session-a:project-a']).toEqual(['/project-a/src']);
    });

    it('updates only the known directory subtree and protects sibling branches and scopes', () => {
        const scopeId = 'session-a:project-a';
        const initial = {
            [scopeId]: [
                '/project-a/src',
                '/project-a/src/nested',
                '/project-a/src/nested/deep',
                '/project-a/src/nested/unknown',
                '/project-a/src2',
            ],
            'session-b:project-b': ['/project-b/docs'],
        };
        const knownChildren = new Map<string, readonly string[]>([
            ['/project-a/src', ['/project-a/src/nested']],
            [
                '/project-a/src/nested',
                ['/project-a/src/nested/deep', '/project-a/src/nested/unknown'],
            ],
            ['/project-a/src/nested/deep', ['/project-a/src']],
            ['/project-a/orphan', ['/project-a/orphan/child']],
        ]);

        const collapsed = setScopedSubtreeExpanded(
            initial,
            scopeId,
            '/project-a/src',
            knownChildren,
            false,
        );
        const expanded = setScopedSubtreeExpanded(
            collapsed,
            scopeId,
            '/project-a/src',
            knownChildren,
            true,
        );

        expect(collapsed).toEqual({
            [scopeId]: ['/project-a/src2'],
            'session-b:project-b': ['/project-b/docs'],
        });
        expect(new Set(expanded[scopeId])).toEqual(
            new Set(initial[scopeId].filter((path) => !path.endsWith('/unknown'))),
        );
        expect(expanded['session-b:project-b']).toEqual(['/project-b/docs']);
        expect(initial[scopeId]).toHaveLength(5);
    });

    it('derives recursive expansion only from current Files query data in the active Project', () => {
        const viewId = 'files-view';
        const scopeId = 'project-a';
        const query = (
            directory: string,
            child: string,
            options: { isInvalidated?: boolean; scopeId?: string; viewId?: string } = {},
        ) => ({
            data: { entries: [{ kind: 'directory', path: child }] },
            isInvalidated: options.isInvalidated ?? false,
            queryKey: controlledViewQueryKey(
                options.viewId ?? viewId,
                'files.list',
                { directory },
                options.scopeId ?? scopeId,
            ),
        });

        const knownChildren = knownDirectoryChildrenFromQueries(
            [
                query('/project', '/project/src'),
                query('/project/src', '/project/src/stale', { isInvalidated: true }),
                query('/other-project', '/other-project/docs', {
                    scopeId: 'project-b',
                }),
                query('/other-view', '/other-view/docs', { viewId: 'other-view' }),
                {
                    data: { entries: [{ kind: 'file', path: '/project/README.md' }] },
                    isInvalidated: false,
                    queryKey: controlledViewQueryKey(
                        viewId,
                        'files.list',
                        { directory: '/project/empty' },
                        scopeId,
                    ),
                },
            ],
            viewId,
            scopeId,
        );

        expect(knownChildren).toEqual(
            new Map([
                ['/project', ['/project/src']],
                ['/project/empty', []],
            ]),
        );
    });

    it('projects only operations owned by the active Workbench Project', () => {
        const operations: PendingFileOperation[] = [
            {
                id: 'operation-a',
                label: 'Copying a',
                projectId: 'project-a',
                affectedPaths: ['/project-a'],
                cancelable: false,
                startedAt: 1,
            },
            {
                id: 'operation-b',
                label: 'Moving b',
                projectId: 'project-b',
                affectedPaths: ['/project-b'],
                cancelable: true,
                startedAt: 2,
            },
        ];

        expect(fileOperationsForProject(operations, 'project-b')).toEqual([operations[1]]);
        expect(fileOperationsForProject(operations, undefined)).toEqual([]);
    });

    it('explains where a trusted workspace symlink points', () => {
        expect(
            fileTreeRowTooltip(
                {
                    kind: 'symlink',
                    linkKind: 'directory',
                    linkTarget: '../../example/.agents/skills/acceptance',
                    path: '/project/.agents/skills/acceptance',
                },
                undefined,
                translate,
            ),
        ).toBe(
            '/project/.agents/skills/acceptance → ../../example/.agents/skills/acceptance (symlink)',
        );
        expect(
            fileTreeRowTooltip(
                {
                    kind: 'symlink',
                    linkKind: 'broken',
                    linkTarget: './missing',
                    path: '/project/stale',
                },
                undefined,
                translate,
            ),
        ).toContain('(broken symlink)');
        expect(
            fileTreeRowTooltip({ kind: 'symlink', path: '/project/stale' }, undefined, translate),
        ).toBe('/project/stale (symlink)');
    });

    it('tells a screen reader the same link facts the tooltip shows', () => {
        expect(
            symlinkRowDescription(
                { linkKind: 'directory', linkTarget: '../shared/skills' },
                translate,
            ),
        ).toBe('Symlink to ../shared/skills.');
        expect(
            symlinkRowDescription({ linkKind: 'broken', linkTarget: './missing' }, translate),
        ).toBe('Symlink to ./missing, which does not resolve.');
        expect(symlinkRowDescription({}, translate)).toBe('Symlink.');
    });

    it('shows the path plus the Git-ignored qualifier for an ordinary row', () => {
        expect(
            fileTreeRowTooltip({ kind: 'file', path: '/project/a.ts' }, undefined, translate),
        ).toBe('/project/a.ts');
        expect(
            fileTreeRowTooltip(
                {
                    gitIgnored: true,
                    kind: 'directory',
                    path: '/project/out',
                },
                undefined,
                translate,
            ),
        ).toBe('/project/out (Git ignored)');
    });

    it('names a child repository in the tooltip, alongside any other qualifier', () => {
        expect(
            fileTreeRowTooltip(
                { kind: 'directory', path: '/project/example' },
                'submodule',
                translate,
            ),
        ).toBe('/project/example (Git submodule)');
        expect(
            fileTreeRowTooltip({ kind: 'directory', path: '/project/vendor' }, 'nested', translate),
        ).toBe('/project/vendor (nested Git repository)');
        expect(
            fileTreeRowTooltip(
                { gitIgnored: true, kind: 'directory', path: '/project/vendor' },
                'nested',
                translate,
            ),
        ).toBe('/project/vendor (nested Git repository, Git ignored)');
    });

    it('speaks only what the row name cannot say, and stays empty for a plain row', () => {
        expect(fileTreeRowDescription({ kind: 'file' }, undefined, undefined, translate)).toBe('');
        expect(
            fileTreeRowDescription(
                { kind: 'directory' },
                'submodule',
                {
                    kind: 'modified',
                    letter: 'M',
                },
                translate,
            ),
        ).toBe('Git submodule. Git: modified.');
        expect(
            fileTreeRowDescription(
                { kind: 'symlink', linkKind: 'directory' },
                'nested',
                undefined,
                translate,
            ),
        ).toBe('Symlink. Nested Git repository.');
    });

    it('follows only work tabs that show a file', () => {
        expect(paneTabFilePath({ id: 'tab-1', resource: { kind: 'file', path: '/p/a.ts' } })).toBe(
            '/p/a.ts',
        );
        expect(
            paneTabFilePath({ id: 'tab-2', resource: { kind: 'terminal', terminalId: 't-1' } }),
        ).toBeUndefined();
        expect(paneTabFilePath(undefined)).toBeUndefined();
    });

    it('keeps filesystem-root captions blank on POSIX and Windows paths', () => {
        expect(fileTreeRootCaption('/')).toBe('');
        expect(fileTreeRootCaption('\\')).toBe('');
        expect(fileTreeRootCaption('/Users/me/project')).toBe('project');
        expect(fileTreeRootCaption(String.raw`C:\work\project`)).toBe('project');
    });
});
