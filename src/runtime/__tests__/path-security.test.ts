import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertInsideRoot, isOutsideRoot } from '../path-security';

describe('isOutsideRoot', () => {
    it('treats the root itself as inside', () => {
        const root = '/workspace/project';
        expect(isOutsideRoot(relative(root, root))).toBe(false);
    });

    it('treats a child path as inside', () => {
        const root = '/workspace/project';
        const child = join(root, 'src', 'index.ts');
        expect(isOutsideRoot(relative(root, child))).toBe(false);
    });

    it('treats a sibling directory sharing a name prefix as outside', () => {
        // A naive `startsWith(root)` check would wrongly treat `/workspace/project-evil` as nested
        // inside `/workspace/project` because it shares the same string prefix. `path.relative`
        // correctly reports this as a parent-traversal path (`../project-evil/...`).
        const root = '/workspace/project';
        const sibling = '/workspace/project-evil/secret.txt';
        expect(isOutsideRoot(relative(root, sibling))).toBe(true);
    });

    it('treats a filename that merely starts with dots as inside', () => {
        expect(isOutsideRoot('..odd.txt')).toBe(false);
        expect(isOutsideRoot(join('nested', '..odd.txt'))).toBe(false);
    });

    it('treats a bare parent-traversal segment as outside', () => {
        expect(isOutsideRoot('..')).toBe(true);
    });

    it('treats a real nested parent traversal path as outside', () => {
        expect(isOutsideRoot(`..${sep}etc${sep}passwd`)).toBe(true);
    });

    it('treats any absolute path as outside regardless of root', () => {
        expect(isOutsideRoot('/etc/passwd')).toBe(true);
    });

    it('treats nested traversal that resolves back inside the root as inside', () => {
        const root = '/workspace/project';
        const resolvedBackInside = join(root, 'a', '..', 'b');
        expect(isOutsideRoot(relative(root, resolvedBackInside))).toBe(false);
    });
});

describe('assertInsideRoot', () => {
    it('does not throw for a path inside the root', () => {
        expect(() =>
            assertInsideRoot('src/index.ts', 'Path escapes the Project root'),
        ).not.toThrow();
    });

    it('throws PATH_DENIED with the caller-provided message for a traversal path', () => {
        expect(() => assertInsideRoot('..', 'Path escapes the Project root')).toThrow(
            expect.objectContaining({
                code: 'PATH_DENIED',
                message: 'Path escapes the Project root',
            }) as Error,
        );
    });

    it('throws PATH_DENIED for an absolute path outside the root', () => {
        expect(() => assertInsideRoot('/etc/passwd', 'Path escapes the Project root')).toThrow(
            expect.objectContaining({ code: 'PATH_DENIED' }) as Error,
        );
    });
});
