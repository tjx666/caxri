import { describe, expect, it } from 'vitest';

import { parseGitHubRemote } from '../git-remote';

describe('parseGitHubRemote', () => {
    it.each([
        ['git@github.com:example/caxri.git', { owner: 'example', repo: 'caxri' }],
        ['https://github.com/example/caxri', { owner: 'example', repo: 'caxri' }],
        ['ssh://git@github.com/example/caxri.git', { owner: 'example', repo: 'caxri' }],
    ])('parses %s', (remote, expected) => {
        expect(parseGitHubRemote(remote)).toEqual(expected);
    });

    it('rejects non-GitHub and malformed remotes', () => {
        expect(parseGitHubRemote('git@gitlab.com:example/caxri.git')).toBeUndefined();
        expect(parseGitHubRemote('https://evilgithub.com/attacker/repo.git')).toBeUndefined();
        expect(parseGitHubRemote('git@notgithub.com:attacker/repo.git')).toBeUndefined();
        expect(
            parseGitHubRemote('https://example.com/github.com/attacker/repo.git'),
        ).toBeUndefined();
        expect(parseGitHubRemote('not a remote')).toBeUndefined();
    });
});
