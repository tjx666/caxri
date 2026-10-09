import { userInfo } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { redactLogValue, redactSecrets } from '../redaction';

describe('home path redaction', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('redacts the OS account home even when HOME points at an isolated fixture', () => {
        const accountHome = userInfo().homedir;
        vi.stubEnv('HOME', '/private/tmp/caxri-fixture/home');

        expect(
            redactLogValue(
                `${accountHome}/runner/_work/_temp/tmp/project and /private/tmp/caxri-fixture/home/.zshrc`,
            ),
        ).toBe('$HOME/runner/_work/_temp/tmp/project and $HOME/.zshrc');
        expect(redactSecrets({ directory: `${accountHome}/fixture` })).toEqual({
            directory: '$HOME/fixture',
        });
    });

    it('keeps a HOME nested under the account home as one token', () => {
        const accountHome = userInfo().homedir;
        vi.stubEnv('HOME', `${accountHome}/isolated-home`);

        expect(redactLogValue(`${accountHome}/isolated-home/file ${accountHome}/other`)).toBe(
            '$HOME/file $HOME/other',
        );
    });
});
