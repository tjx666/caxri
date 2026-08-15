import type { FileEntry } from '@shared/types';
import { describe, expect, it } from 'vitest';

import {
    completePathQuery,
    filterPathEntries,
    parentDirectoryWithinRoot,
    pathBrowserCreateCandidate,
    pathBrowserEmptyMessage,
} from './path-browser';

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
        expect(completePathQuery([entries[2]], 'read', true)).toBeUndefined();
    });

    it('distinguishes an exhausted scan from an authoritative empty result', () => {
        expect(pathBrowserEmptyMessage(0, true)).toBe(
            'No match in the scanned items. Refine or open a narrower folder.',
        );
        expect(pathBrowserEmptyMessage(0, false)).toBe('No matching file or folder.');
        expect(pathBrowserEmptyMessage(1, true)).toBeUndefined();
    });

    it('returns to a parent without ever crossing the Project root', () => {
        expect(parentDirectoryWithinRoot('/project', '/project/src/nested')).toBe('/project/src');
        expect(parentDirectoryWithinRoot('/project', '/project/src')).toBe('/project');
        expect(parentDirectoryWithinRoot('/project', '/project')).toBe('/project');
        expect(parentDirectoryWithinRoot('/project', '/outside')).toBe('/project');
        expect(parentDirectoryWithinRoot('/', '/project/src')).toBe('/project');
        expect(parentDirectoryWithinRoot('/', '/project')).toBe('/');
    });

    it('offers to create a file for a plain name once nothing matches', () => {
        expect(pathBrowserCreateCandidate('notes.md', 0, false)).toEqual({
            kind: 'file',
            name: 'notes.md',
        });
    });

    it('offers to create a folder when the name ends with a trailing slash', () => {
        expect(pathBrowserCreateCandidate('drafts/', 0, false)).toEqual({
            kind: 'directory',
            name: 'drafts',
        });
    });

    it('never offers to create while an existing match is still possible', () => {
        expect(pathBrowserCreateCandidate('README.md', 1, false)).toBeUndefined();
        expect(pathBrowserCreateCandidate('missing', 0, true)).toBeUndefined();
        expect(pathBrowserCreateCandidate('', 0, false)).toBeUndefined();
    });

    it('rejects names that are not a single path segment', () => {
        expect(pathBrowserCreateCandidate('.', 0, false)).toBeUndefined();
        expect(pathBrowserCreateCandidate('..', 0, false)).toBeUndefined();
        expect(pathBrowserCreateCandidate('nested/name', 0, false)).toBeUndefined();
        expect(pathBrowserCreateCandidate('/', 0, false)).toBeUndefined();
    });
});
