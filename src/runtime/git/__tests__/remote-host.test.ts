import { describe, expect, it } from 'vitest';

import { parseGitRemoteHost } from '../remote-host';

describe('parseGitRemoteHost', () => {
    it('resolves an HTTPS remote', () => {
        expect(parseGitRemoteHost('https://github.com/tjx666/caxri.git')).toBe('github.com');
    });

    it('resolves an ssh:// remote', () => {
        expect(parseGitRemoteHost('ssh://git@github.com/tjx666/caxri.git')).toBe('github.com');
    });

    it('resolves the scp-like shorthand', () => {
        expect(parseGitRemoteHost('git@github.com:tjx666/caxri.git')).toBe('github.com');
    });

    it('lower-cases a mixed-case host', () => {
        expect(parseGitRemoteHost('https://GitHub.com/tjx666/caxri.git')).toBe('github.com');
    });

    it('resolves a GitHub Enterprise custom domain distinctly from github.com', () => {
        expect(parseGitRemoteHost('git@github.example.com:team/repo.git')).toBe(
            'github.example.com',
        );
    });

    it('returns null for an empty or missing remote', () => {
        expect(parseGitRemoteHost('')).toBeNull();
        expect(parseGitRemoteHost(' '.repeat(3))).toBeNull();
    });

    it('returns null for an unparseable value', () => {
        expect(parseGitRemoteHost('not a url')).toBeNull();
    });
});
