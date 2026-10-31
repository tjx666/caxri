import { describe, expect, it } from 'vitest';

import {
    fileViewerInitialLine,
    fileViewerTarget,
    isFileViewerLineCited,
} from '../file-viewer-model';

describe('fileViewerTarget', () => {
    it('reads the path and the cited lines the way Desktop opens them', () => {
        expect(fileViewerTarget('src/app.ts:12')).toEqual({
            endLine: 12,
            name: 'app.ts',
            path: 'src/app.ts',
            startLine: 12,
        });
        expect(fileViewerTarget('/repo/docs/a.md#L3-L5')).toEqual({
            endLine: 5,
            name: 'a.md',
            path: '/repo/docs/a.md',
            startLine: 3,
        });
        expect(fileViewerTarget('src/app.ts:12:4')).toMatchObject({ endLine: 12, startLine: 12 });
    });

    it('opens a citation without a location, or with a malformed one, at the top', () => {
        expect(fileViewerTarget('package.json')).toEqual({
            name: 'package.json',
            path: 'package.json',
        });
        expect(fileViewerTarget('a.ts#L5-L2')).toEqual({ name: 'a.ts', path: 'a.ts' });
    });
});

describe('cited lines', () => {
    const target = fileViewerTarget('a.ts#L10-L12');

    it('tints only the cited range', () => {
        expect([8, 9, 10, 11, 12].map((index) => isFileViewerLineCited(target, index))).toEqual([
            false,
            true,
            true,
            true,
            false,
        ]);
        expect(isFileViewerLineCited(fileViewerTarget('a.ts'), 0)).toBe(false);
    });

    it('scrolls to a few lines above the citation, inside the file', () => {
        expect(fileViewerInitialLine(target, 100)).toBe(6);
        expect(fileViewerInitialLine(fileViewerTarget('a.ts:2'), 100)).toBe(0);
        expect(fileViewerInitialLine(fileViewerTarget('a.ts:500'), 20)).toBe(19);
        expect(fileViewerInitialLine(fileViewerTarget('a.ts'), 20)).toBe(0);
    });
});
