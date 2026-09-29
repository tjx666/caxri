import { describe, expect, it } from 'vitest';

import { detachedHeadReference, parseGitStatus } from '../status';

describe('parseGitStatus', () => {
    it('reads the tracked upstream branch', () => {
        const output = [
            '# branch.oid 0123456789012345678901234567890123456789',
            '# branch.head main',
            '# branch.upstream origin/main',
            '# branch.ab +2 -1',
            '',
        ].join('\0');
        expect(parseGitStatus(output)).toMatchObject({
            branch: 'main',
            upstream: 'origin/main',
            ahead: 2,
            behind: 1,
        });
    });

    it('leaves upstream absent for an unpublished branch', () => {
        const output = [
            '# branch.oid 0123456789012345678901234567890123456789',
            '# branch.head topic',
            '',
        ].join('\0');
        expect(parseGitStatus(output)).not.toHaveProperty('upstream');
    });
});

describe('detachedHeadReference', () => {
    it('prefers a tag over a remote branch at the same commit', () => {
        expect(detachedHeadReference('refs/remotes/origin/main\nrefs/tags/v1.2.0\n')).toBe(
            'v1.2.0',
        );
    });

    it('falls back to a remote branch and skips the symbolic remote HEAD', () => {
        expect(detachedHeadReference('refs/remotes/origin/HEAD\nrefs/remotes/origin/main\n')).toBe(
            'origin/main',
        );
    });

    it('is absent when nothing points at the commit', () => {
        expect(detachedHeadReference('')).toBeUndefined();
    });
});
