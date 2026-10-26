import { describe, expect, it } from 'vitest';

import { redactArgv, redactCommandLine, redactSecretText } from '../redaction';

describe('secret redaction', () => {
    it('redacts URL userinfo credentials while keeping host and path', () => {
        expect(redactSecretText('clone https://user:p%40ss@example.com/org/repo.git now')).toBe(
            'clone https://[REDACTED]@example.com/org/repo.git now',
        );
        expect(redactSecretText('ssh://deploy:pw@git.example.com:2222/repo')).toBe(
            'ssh://[REDACTED]@git.example.com:2222/repo',
        );
        expect(redactSecretText('https://abc123token@example.com/a?b=c')).toBe(
            'https://[REDACTED]@example.com/a?b=c',
        );
    });

    it('leaves URLs without userinfo unchanged', () => {
        const url = 'https://example.com/path/user@host?x=1#a@b';
        expect(redactSecretText(url)).toBe(url);
    });

    it('redacts quoted JSON secret fields without breaking their structure', () => {
        const source = JSON.stringify({
            token: 'v_token_7x',
            api_key: 'v_key_7x',
            password: 'v_pass_7x',
            authorization: 'v_auth_7x',
            message: 'keep me',
        });
        const redacted = redactSecretText(source);

        expect(JSON.parse(redacted)).toEqual({
            token: '[REDACTED]',
            api_key: '[REDACTED]',
            password: '[REDACTED]',
            authorization: '[REDACTED]',
            message: 'keep me',
        });
        expect(redacted).not.toContain('v_token_7x');
        expect(redacted).not.toContain('v_key_7x');
        expect(redacted).not.toContain('v_pass_7x');
        expect(redacted).not.toContain('v_auth_7x');
    });

    it('keeps unquoted assignment redaction behavior', () => {
        expect(redactSecretText('token=private-value')).toBe('token=[REDACTED]');
    });
});

describe('argv redaction', () => {
    it('replaces the element after a credential flag and keeps the surrounding argv', () => {
        expect(
            redactArgv([
                '--model',
                'opus',
                '--api-key',
                'v_key_7x',
                '--github-token',
                'v_token_7x',
            ]),
        ).toEqual(['--model', 'opus', '--api-key', '[REDACTED]', '--github-token', '[REDACTED]']);
    });

    it('replaces the whole inline value, including spaces inside one argv element', () => {
        expect(redactArgv(['--password=v pass 7x', '--sandbox=workspace'])).toEqual([
            '--password=[REDACTED]',
            '--sandbox=workspace',
        ]);
    });

    it('replaces a separated value that contains spaces as one element', () => {
        expect(redactArgv(['--secret', 'v secret 7x'])).toEqual(['--secret', '[REDACTED]']);
    });

    it('does not let a credential-named boolean flag shield the next credential value', () => {
        expect(redactArgv(['--skip-password-prompt', '--password', 'v_pass_7x'])).toEqual([
            '--skip-password-prompt',
            '--password',
            '[REDACTED]',
        ]);
    });

    it('redacts persisted command-line fragments stored as one element', () => {
        expect(redactArgv(['--api-key v_key_7x', '--mode run'])).toEqual([
            '--api-key=[REDACTED]',
            '--mode run',
        ]);
        expect(redactArgv(['--mode run --token', 'v_token_7x'])).toEqual([
            '--mode run --token',
            '[REDACTED]',
        ]);
    });

    it('leaves argv without credential flags unchanged', () => {
        const arguments_ = ['--dangerously-skip-permissions', '--model', 'opus', 'my-token-file'];
        expect(redactArgv(arguments_)).toEqual(arguments_);
    });

    it('supports a caller-chosen replacement marker', () => {
        expect(redactArgv(['--token', 'v_token_7x'], '<redacted>')).toEqual([
            '--token',
            '<redacted>',
        ]);
    });
});

describe('command-line redaction', () => {
    it('redacts separated, inline, and quoted credential flag values', () => {
        expect(
            redactCommandLine(
                'agent --api-key v_key_7x --token=v_token_7x --password "v pass 7x" --mode run',
            ),
        ).toBe('agent --api-key=[REDACTED] --token=[REDACTED] --password=[REDACTED] --mode run');
    });

    it('only treats whole flag tokens as flags', () => {
        expect(redactCommandLine('/usr/local/bin/git-credential-manager get')).toBe(
            '/usr/local/bin/git-credential-manager get',
        );
    });

    it('does not let a credential-named boolean flag shield the next credential value', () => {
        expect(redactCommandLine('agent --skip-password-prompt --password v_pass_7x')).toBe(
            'agent --skip-password-prompt --password=[REDACTED]',
        );
    });
});
