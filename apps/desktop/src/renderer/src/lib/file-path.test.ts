import { describe, expect, it } from 'vitest';

import { parentDirectoryPath, remapPath } from './file-path';

describe('file path mutation helpers', () => {
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

    it('resolves the directory that directly owns an absolute path', () => {
        expect(parentDirectoryPath('/project/src')).toBe('/project');
        expect(parentDirectoryPath('/project/src/index.ts')).toBe('/project/src');
        expect(parentDirectoryPath('/file.ts')).toBe('/');
    });
});
