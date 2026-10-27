import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentEnvironment } from '../../contract';
import { resolveCodexHome } from './paths';

/**
 * Whether a Codex sign-in mode keeps its prompt cache with no expiry. The mode is named by `account/read`
 * (`account.type`), `account/updated` (`authMode`), or `auth_mode` in `auth.json`. Since 2026-10-21 OpenAI keeps the
 * cache of ChatGPT-signed-in Codex users forever, so returning to an old conversation never re-reads it at full price.
 * An API key, Amazon Bedrock, or a mode Codex did not report keeps the 30-minute estimate.
 *
 * @see https://x.com/thsottiaux/status/2112712984644784534
 */
export function hasForeverCodexCache(authMode: string | undefined): boolean {
    return authMode === 'chatgpt' || authMode === 'chatgptAuthTokens';
}

/**
 * Reads the sign-in mode Codex recorded in `$CODEX_HOME/auth.json`. A missing, unreadable, or malformed file reports no
 * mode, so callers keep the conservative 30-minute estimate. Only the `auth_mode` string is read; credentials in the
 * file are never returned or logged.
 */
export async function readCodexAuthMode(
    environment: AgentEnvironment,
): Promise<string | undefined> {
    try {
        const file = join(resolveCodexHome(environment), 'auth.json');
        const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
        const mode =
            parsed !== null && typeof parsed === 'object'
                ? (parsed as { auth_mode?: unknown }).auth_mode
                : undefined;
        return typeof mode === 'string' ? mode : undefined;
    } catch {
        return undefined;
    }
}
