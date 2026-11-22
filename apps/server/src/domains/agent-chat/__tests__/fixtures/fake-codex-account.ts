import process from 'node:process';

import type { FakeCodexIo } from './fake-codex-io.ts';
import { consumeResetCredit, rateLimitsReadResult } from './fake-codex-usage-limit.ts';

function idempotencyKey(parameters: unknown): string | undefined {
    if (typeof parameters !== 'object' || parameters === null) return undefined;
    const key = (parameters as { idempotencyKey?: unknown }).idempotencyKey;
    return typeof key === 'string' ? key : undefined;
}

/**
 * `account/rateLimits/read` and `account/rateLimitResetCredit/consume` (see `fake-codex-usage-limit.ts`), and
 * `account/read`: the sign-in named by `FAKE_CODEX_ACCOUNT_TYPE`. Without it `account/read` is unknown, as it is to a
 * Codex that predates it.
 */
export function didHandleAccountRequest(
    io: FakeCodexIo,
    id: number | undefined,
    method: string | undefined,
    parameters?: unknown,
): boolean {
    if (method === 'account/rateLimits/read') {
        io.send({ id, result: rateLimitsReadResult() });
        return true;
    }
    if (method === 'account/rateLimitResetCredit/consume') {
        io.send({ id, result: { outcome: consumeResetCredit(idempotencyKey(parameters)) } });
        return true;
    }
    if (method !== 'account/read') return false;
    const type = process.env.FAKE_CODEX_ACCOUNT_TYPE;
    io.send(
        type
            ? { id, result: { account: { type }, requiresOpenaiAuth: true } }
            : { id, error: { code: -32600, message: 'unknown variant `account/read`' } },
    );
    return true;
}
