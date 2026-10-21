import process from 'node:process';

import type { FakeCodexIo } from './fake-codex-io.ts';

/**
 * `account/read`: the sign-in named by `FAKE_CODEX_ACCOUNT_TYPE`. Without it the method is unknown, as it is to a Codex
 * that predates it.
 */
export function didHandleAccountRequest(
    io: FakeCodexIo,
    id: number | undefined,
    method: string | undefined,
): boolean {
    if (method !== 'account/read') return false;
    const type = process.env.FAKE_CODEX_ACCOUNT_TYPE;
    io.send(
        type
            ? { id, result: { account: { type }, requiresOpenaiAuth: true } }
            : { id, error: { code: -32600, message: 'unknown variant `account/read`' } },
    );
    return true;
}
