import { describe, expect, it } from 'vitest';

import { isPathAtOrBelow, projectDisplayPath, projectRelativePath } from '../project-path';

describe('Project paths', () => {
    it('matches exact and descendant paths without matching sibling prefixes', () => {
        expect(isPathAtOrBelow('/project/src', '/project/src')).toBe(true);
        expect(isPathAtOrBelow('/project/src/nested/a.ts', '/project/src')).toBe(true);
        expect(isPathAtOrBelow('/project/src-old/a.ts', '/project/src')).toBe(false);
        expect(isPathAtOrBelow('/project/src/a.ts', '/')).toBe(true);
    });

    it('derives only paths contained by the current Project', () => {
        expect(projectRelativePath('/project/src/file.ts', '/project')).toBe('src/file.ts');
        expect(projectRelativePath('/project', '/project')).toBe('.');
        expect(projectRelativePath('/project-other/file.ts', '/project')).toBeUndefined();
        expect(projectRelativePath('/project/src/file.ts', '/')).toBe('project/src/file.ts');
    });

    it('names a file Project-relative inside the Project and absolute outside it', () => {
        expect(projectDisplayPath('/project/src/greeting.ts', '/project')).toBe('src/greeting.ts');
        expect(projectDisplayPath('/elsewhere/notes.md', '/project')).toBe('/elsewhere/notes.md');
        expect(projectDisplayPath('/project/src/greeting.ts', undefined)).toBe(
            '/project/src/greeting.ts',
        );
    });
});
