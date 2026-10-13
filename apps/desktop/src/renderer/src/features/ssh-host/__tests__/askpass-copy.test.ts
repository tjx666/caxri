import { describe, expect, it } from 'vitest';

import { askpassAttempt, askpassTitleKey } from '../askpass-copy';

describe('askpass copy', () => {
    it('titles the prompt by what OpenSSH asks for', () => {
        expect(askpassTitleKey({ kind: 'confirm', prompt: 'Are you sure?' })).toBe(
            'sshHost.askpass.verifyTitle',
        );
        expect(
            askpassTitleKey({
                kind: 'secret',
                prompt: "Enter passphrase for key '/k/id_ed25519':",
            }),
        ).toBe('sshHost.askpass.passphraseTitle');
        expect(askpassTitleKey({ kind: 'secret', prompt: "dev@devbox's password:" })).toBe(
            'sshHost.askpass.passwordTitle',
        );
        expect(askpassTitleKey({ kind: 'secret', prompt: 'Verification code:' })).toBe(
            'sshHost.askpass.title',
        );
    });

    it('counts the first answer as attempt 1', () => {
        expect(askpassAttempt(1)).toBe(2);
    });
});
