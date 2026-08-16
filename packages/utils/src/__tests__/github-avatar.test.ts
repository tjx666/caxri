import { describe, expect, it } from 'vitest';

import { gitHubAvatarUrl } from '../github-avatar';

describe('gitHubAvatarUrl', () => {
    it('maps a modern noreply address to the numeric account avatar', () => {
        expect(gitHubAvatarUrl('12345+octocat@users.noreply.github.com', 64)).toBe(
            'https://avatars.githubusercontent.com/u/12345?s=64&v=4',
        );
    });

    it('maps a legacy noreply address to the login avatar', () => {
        expect(gitHubAvatarUrl('octocat@users.noreply.github.com', 40)).toBe(
            'https://avatars.githubusercontent.com/octocat?s=40&v=4',
        );
    });

    it('maps a bot noreply address to the bot login avatar', () => {
        expect(gitHubAvatarUrl('41898282+github-actions[bot]@users.noreply.github.com', 32)).toBe(
            'https://avatars.githubusercontent.com/u/41898282?s=32&v=4',
        );
    });

    it('routes an ordinary email through the GitHub email lookup endpoint', () => {
        expect(gitHubAvatarUrl('dev@example.com', 64)).toBe(
            'https://avatars.githubusercontent.com/u/e?email=dev%40example.com&s=64',
        );
    });

    it('returns undefined for an empty or whitespace-only email', () => {
        expect(gitHubAvatarUrl('', 64)).toBeUndefined();
        expect(gitHubAvatarUrl(' '.repeat(3), 64)).toBeUndefined();
    });
});
