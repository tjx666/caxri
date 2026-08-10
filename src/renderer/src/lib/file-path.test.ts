import { describe, expect, it } from 'vitest';

import { pathIsAtOrBelow, projectRelativePath, remapPath } from './file-path';

describe('file path mutation helpers', () => {
    it('matches exact and descendant paths without matching sibling prefixes', () => {
        expect(pathIsAtOrBelow('/project/src', '/project/src')).toBe(true);
        expect(pathIsAtOrBelow('/project/src/nested/a.ts', '/project/src')).toBe(true);
        expect(pathIsAtOrBelow('/project/src-old/a.ts', '/project/src')).toBe(false);
    });

    it('preserves a descendant suffix when its parent moves', () => {
        expect(remapPath('/project/src/nested/a.ts', '/project/src', '/project/lib')).toBe(
            '/project/lib/nested/a.ts',
        );
        expect(remapPath('/project/other.ts', '/project/src', '/project/lib')).toBe(
            '/project/other.ts',
        );
    });

    it('derives only paths contained by the current Project', () => {
        expect(projectRelativePath('/project/src/file.ts', '/project')).toBe('src/file.ts');
        expect(projectRelativePath('/project', '/project')).toBe('.');
        expect(projectRelativePath('/project-other/file.ts', '/project')).toBeUndefined();
    });
});
