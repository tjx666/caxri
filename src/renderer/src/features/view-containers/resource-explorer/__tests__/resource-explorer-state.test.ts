import { describe, expect, it } from 'vitest';

import type { PendingFileOperation } from '../file-operation-state';
import {
    fileOperationsForProject,
    fileTreeRootCaption,
    scopedValue,
    setScopedPathExpanded,
    setScopedValue,
} from '../resource-explorer-state';

describe('Resource Explorer state', () => {
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

    it('keeps filesystem-root captions blank on POSIX and Windows paths', () => {
        expect(fileTreeRootCaption('/')).toBe('');
        expect(fileTreeRootCaption('\\')).toBe('');
        expect(fileTreeRootCaption('/Users/tj/project')).toBe('project');
        expect(fileTreeRootCaption(String.raw`C:\work\project`)).toBe('project');
    });
});
