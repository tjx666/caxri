import { describe, expect, it } from 'vitest';

import { deriveRepoKey } from '../repo-key';

describe('deriveRepoKey', () => {
    it.each([
        ['git@github.com:owner/repo.git', 'github.com/owner/repo'],
        ['ssh://git@github.com/owner/repo.git', 'github.com/owner/repo'],
        ['ssh://git@github.com:22/owner/repo', 'github.com/owner/repo'],
        ['https://github.com/Owner/Repo.git', 'github.com/owner/repo'],
        ['https://github.com/owner/repo/', 'github.com/owner/repo'],
        ['https://x-access-token:secret@github.com/owner/repo.git', 'github.com/owner/repo'],
        ['github.com:owner/repo', 'github.com/owner/repo'],
        ['https://gitlab.example.com/group/sub/repo.git', 'gitlab.example.com/group/sub/repo'],
    ])('normalizes %s', (remote, key) => {
        expect(deriveRepoKey(remote)).toBe(key);
    });

    it('keeps forks and mirrors apart', () => {
        expect(deriveRepoKey('git@github.com:fork/repo.git')).not.toBe(
            deriveRepoKey('git@github.com:owner/repo.git'),
        );
        expect(deriveRepoKey('https://gitlab.com/owner/repo')).not.toBe(
            deriveRepoKey('https://github.com/owner/repo'),
        );
    });

    it('never carries credentials', () => {
        expect(deriveRepoKey('https://user:hunter2@github.com/owner/repo.git')).not.toContain(
            'hunter2',
        );
    });

    it.each([
        '',
        ' '.repeat(3),
        '/srv/git/repo.git',
        '../repo',
        'file:///srv/git/repo.git',
        'https://github.com/',
    ])('returns null for %j', (remote) => {
        expect(deriveRepoKey(remote)).toBeNull();
    });
});
