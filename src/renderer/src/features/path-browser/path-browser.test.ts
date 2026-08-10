import { describe, expect, it } from 'vitest';

import type { FileEntry } from '@shared/types';

import { completePathQuery, filterPathEntries, parentDirectoryWithinRoot } from './path-browser';

const entries: FileEntry[] = [
    { kind: 'directory', name: 'src', path: '/project/src' },
    { kind: 'directory', name: 'scripts', path: '/project/scripts' },
    { kind: 'file', name: 'README.md', path: '/project/README.md', size: 10 },
    { kind: 'file', name: 'package.json', path: '/project/package.json', size: 10 },
];

describe('path browser navigation', () => {
    it('filters only the current directory without reordering Runtime results', () => {
        expect(filterPathEntries(entries, 's')).toEqual([entries[0], entries[1], entries[3]]);
        expect(filterPathEntries(entries, 'read')).toEqual([entries[2]]);
        expect(filterPathEntries(entries, '')).toEqual(entries);
    });

    it('completes only a unique candidate', () => {
        expect(completePathQuery(entries, 'read')).toBe('README.md');
        expect(completePathQuery(entries, 's')).toBeUndefined();
        expect(completePathQuery(entries, 'missing')).toBeUndefined();
    });

    it('returns to a parent without ever crossing the Project root', () => {
        expect(parentDirectoryWithinRoot('/project', '/project/src/nested')).toBe('/project/src');
        expect(parentDirectoryWithinRoot('/project', '/project/src')).toBe('/project');
        expect(parentDirectoryWithinRoot('/project', '/project')).toBe('/project');
        expect(parentDirectoryWithinRoot('/project', '/outside')).toBe('/project');
        expect(parentDirectoryWithinRoot('/', '/project/src')).toBe('/project');
        expect(parentDirectoryWithinRoot('/', '/project')).toBe('/');
    });
});
