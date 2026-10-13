import type { RemoteAskpassRequest } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

/**
 * Titles the OpenSSH prompt by what it asks for. OpenSSH's prompt text is English and stable (`Enter passphrase for key
 * '…':`, `user@host's password:`), so a key passphrase and a password each get a plain title; anything else (a 2FA
 * code, a keyboard-interactive question) keeps the generic one.
 */
export function askpassTitleKey(
    request: Pick<RemoteAskpassRequest, 'kind' | 'prompt'>,
): TranslationKey {
    if (request.kind === 'confirm') return 'sshHost.askpass.verifyTitle';
    if (/passphrase/iu.test(request.prompt)) return 'sshHost.askpass.passphraseTitle';
    if (/password/iu.test(request.prompt)) return 'sshHost.askpass.passwordTitle';
    return 'sshHost.askpass.title';
}

/**
 * The attempt this prompt is, counting the first answer as attempt 1: `retry` counts the answers already rejected.
 */
export function askpassAttempt(retry: number): number {
    return retry + 1;
}
