import { describe, expect, it } from 'vitest';

import { parentDirectoryPath, updateFileTreeChangeRevisions } from './file-tree-refresh';

describe('file tree refresh routing', () => {
    it('routes each changed path to the directory that directly owns it', () => {
        expect(parentDirectoryPath('/project/src')).toBe('/project');
        expect(parentDirectoryPath('/project/src/index.ts')).toBe('/project/src');
        expect(parentDirectoryPath('/file.ts')).toBe('/');
    });

    it('does not advance unrelated expanded directories', () => {
        const first = updateFileTreeChangeRevisions(
            { directories: {}, overflow: 0 },
            {
                changes: [{ kind: 'update', path: '/project/src/index.ts' }],
                overflow: false,
                sessionId: 'session-1',
            },
        );
        const second = updateFileTreeChangeRevisions(first, {
            changes: [{ kind: 'update', path: '/project/scripts/build.ts' }],
            overflow: false,
            sessionId: 'session-1',
        });

        expect(second.directories).toEqual({ '/project/src': 1, '/project/scripts': 1 });
        expect(second.overflow).toBe(0);
    });
});
