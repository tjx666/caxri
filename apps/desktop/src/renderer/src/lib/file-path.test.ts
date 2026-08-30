import { describe, expect, it } from 'vitest';

import { isPathAtOrBelow, parentDirectoryPath, projectRelativePath, remapPath } from './file-path';

describe('file path mutation helpers', () => {
    it('matches exact and descendant paths without matching sibling prefixes', () => {
        expect(isPathAtOrBelow('/project/src', '/project/src')).toBe(true);
        expect(isPathAtOrBelow('/project/src/nested/a.ts', '/project/src')).toBe(true);
        expect(isPathAtOrBelow('/project/src-old/a.ts', '/project/src')).toBe(false);
        expect(isPathAtOrBelow('/project/src/a.ts', '/')).toBe(true);
    });

    it('preserves a descendant suffix when its parent moves', () => {
        expect(remapPath('/project/src/nested/a.ts', '/project/src', '/project/lib')).toBe(
            '/project/lib/nested/a.ts',
        );
        expect(remapPath('/project/other.ts', '/project/src', '/project/lib')).toBe(
            '/project/other.ts',
        );
        expect(remapPath('/project/src/a.ts', '/', '/workspace')).toBe(
            '/workspace/project/src/a.ts',
        );
    });

    it('derives only paths contained by the current Project', () => {
        expect(projectRelativePath('/project/src/file.ts', '/project')).toBe('src/file.ts');
        expect(projectRelativePath('/project', '/project')).toBe('.');
        expect(projectRelativePath('/project-other/file.ts', '/project')).toBeUndefined();
        expect(projectRelativePath('/project/src/file.ts', '/')).toBe('project/src/file.ts');
    });

    it('resolves the directory that directly owns an absolute path', () => {
        expect(parentDirectoryPath('/project/src')).toBe('/project');
        expect(parentDirectoryPath('/project/src/index.ts')).toBe('/project/src');
        expect(parentDirectoryPath('/file.ts')).toBe('/');
    });
});
