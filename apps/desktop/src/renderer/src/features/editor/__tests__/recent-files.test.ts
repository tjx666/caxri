import { describe, expect, it } from 'vitest';

import {
    forgetRecentFile,
    isRecordableRecentFile,
    matchRecentFiles,
    MAX_RECENT_FILES,
    parseRecentFiles,
    recordRecentFile,
} from '../recent-files';

describe('recordRecentFile', () => {
    it('puts the newest file first and moves a reopened file to the front without duplicating it', () => {
        expect(recordRecentFile(['/p/a.ts', '/p/b.ts'], '/p/c.ts')).toEqual([
            '/p/c.ts',
            '/p/a.ts',
            '/p/b.ts',
        ]);
        expect(recordRecentFile(['/p/a.ts', '/p/b.ts', '/p/c.ts'], '/p/c.ts')).toEqual([
            '/p/c.ts',
            '/p/a.ts',
            '/p/b.ts',
        ]);
    });

    it('keeps the history within its bound by dropping the oldest', () => {
        const full = Array.from({ length: MAX_RECENT_FILES }, (_, index) => `/p/${index}.ts`);
        const next = recordRecentFile(full, '/p/new.ts');

        expect(next).toHaveLength(MAX_RECENT_FILES);
        expect(next[0]).toBe('/p/new.ts');
        expect(next).not.toContain(`/p/${MAX_RECENT_FILES - 1}.ts`);
    });
});

describe('recent file storage values', () => {
    it('reads only distinct non-empty strings and tolerates foreign values', () => {
        expect(parseRecentFiles(['/p/a.ts', '', 3, '/p/a.ts', null, '/p/b.ts'])).toEqual([
            '/p/a.ts',
            '/p/b.ts',
        ]);
        expect(parseRecentFiles('nope')).toEqual([]);
        expect(parseRecentFiles(undefined)).toEqual([]);
    });

    it('forgets one path', () => {
        expect(forgetRecentFile(['/p/a.ts', '/p/b.ts'], '/p/a.ts')).toEqual(['/p/b.ts']);
    });
});

describe('isRecordableRecentFile', () => {
    it('accepts Project files and rejects outside paths, the root, and virtual tabs', () => {
        expect(isRecordableRecentFile('/p', '/p/src/a.ts')).toBe(true);
        expect(isRecordableRecentFile('/p', '/p')).toBe(false);
        expect(isRecordableRecentFile('/p', '/pp/a.ts')).toBe(false);
        expect(isRecordableRecentFile('/p', '/etc/hosts')).toBe(false);
        expect(isRecordableRecentFile('/p', 'caxri-untitled://1')).toBe(false);
    });
});

describe('matchRecentFiles', () => {
    const paths = ['/p/src/app.ts', '/p/README.md', '/p/src/ui/application.tsx', '/outside/x.ts'];

    it('lists every recent Project file in recency order for an empty filter', () => {
        const matches = matchRecentFiles({ filter: '', paths, root: '/p' });

        expect(matches.map((match) => match.path)).toEqual([
            '/p/src/app.ts',
            '/p/README.md',
            '/p/src/ui/application.tsx',
        ]);
        expect(matches[0]).toEqual({
            directoryLabel: 'src',
            name: 'app.ts',
            path: '/p/src/app.ts',
        });
        expect(matches[1]?.directoryLabel).toBe('');
    });

    it('leaves the active file out', () => {
        const matches = matchRecentFiles({
            excludePath: '/p/src/app.ts',
            filter: '',
            paths,
            root: '/p',
        });

        expect(matches.map((match) => match.name)).toEqual(['README.md', 'application.tsx']);
    });

    it('filters on the file name case-insensitively and ranks prefix, then substring, then fuzzy', () => {
        const ranked = matchRecentFiles({
            filter: 'APP',
            paths: ['/p/my-app.ts', '/p/application.tsx', '/p/a-p-p.ts', '/p/other.ts'],
            root: '/p',
        });

        expect(ranked.map((match) => match.name)).toEqual([
            'application.tsx',
            'my-app.ts',
            'a-p-p.ts',
        ]);
    });

    it('does not match the directory part for a bare filter', () => {
        expect(matchRecentFiles({ filter: 'src', paths, root: '/p' })).toEqual([]);
    });
});
