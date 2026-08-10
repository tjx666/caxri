import { describe, expect, it } from 'vitest';

import { pathIsAtOrBelow, remapPath } from './file-path';

describe('file path mutation helpers', () => {
    it('matches exact and descendant paths without matching sibling prefixes', () => {
        expect(pathIsAtOrBelow('/project/src', '/project/src')).toBe(true);
        expect(pathIsAtOrBelow('/project/src/nested/a.ts', '/project/src')).toBe(true);
        expect(pathIsAtOrBelow('/project/src-old/a.ts', '/project/src')).toBe(false);
    });

    it('treats the filesystem root as the parent of every absolute path', () => {
        expect(pathIsAtOrBelow('/project/file.ts', '/')).toBe(true);
        expect(pathIsAtOrBelow('/', '/')).toBe(true);
    });

    it('preserves a descendant suffix when its parent moves', () => {
        expect(remapPath('/project/src/nested/a.ts', '/project/src', '/project/lib')).toBe(
            '/project/lib/nested/a.ts',
        );
        expect(remapPath('/project/other.ts', '/project/src', '/project/lib')).toBe(
            '/project/other.ts',
        );
    });
});
