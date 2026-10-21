import { isRecord, stringField } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import { withCacheRewriteEstimate } from './chat-usage';
import { mapCodexUsage } from './codex-items';
import type { JsonRpcConnection } from './json-rpc-connection';

/**
 * How long Codex's prompt cache is assumed to survive an idle Chat, in minutes, for an account that pays per request
 * (an API key, Amazon Bedrock). OpenAI's default retention is 30 minutes, longer only when a request opts into 12-hour
 * caching, and the CLI reports neither the policy nor an expiry, so this is an estimate that only drives the composer's
 * cache hint.
 *
 * @see https://developers.openai.com/api/docs/guides/prompt-caching
 */
export const CODEX_CACHE_TTL_MINUTES = 30;

const ACCOUNT_READ_TIMEOUT_MS = 5_000;

/**
 * The cache lifetime for a Codex sign-in mode, as `account/read` (`account.type`) or `account/updated` (`authMode`)
 * names it. A ChatGPT sign-in keeps its cache with no expiry: since 2026-10-21 OpenAI keeps the cache of signed-in
 * Codex users forever, so returning to an old conversation never re-reads it at full price, and an expiry hint would be
 * wrong. Any other mode, and a mode Codex did not report, keeps the 30-minute estimate.
 *
 * @see https://x.com/thsottiaux/status/2112712984644784534
 */
export function codexCacheTtlMinutes(authMode: string | undefined): number | undefined {
    return authMode === 'chatgpt' || authMode === 'chatgptAuthTokens'
        ? undefined
        : CODEX_CACHE_TTL_MINUTES;
}

/**
 * Reads the Chat's sign-in mode with `account/read` and returns its cache lifetime. A Codex that cannot answer keeps
 * the estimate rather than failing the Chat's start.
 */
export async function readCodexCacheTtlMinutes(
    connection: JsonRpcConnection,
): Promise<number | undefined> {
    let result: unknown;
    try {
        result = await connection.request('account/read', {}, ACCOUNT_READ_TIMEOUT_MS);
    } catch {
        return CODEX_CACHE_TTL_MINUTES;
    }
    const account = isRecord(result) && isRecord(result.account) ? result.account : undefined;
    return codexCacheTtlMinutes(stringField(account?.type));
}

/**
 * A Codex Chat's context usage (`thread/tokenUsage/updated`) and the prompt cache lifetime its sign-in grants, kept
 * current from `account/read` at start and `account/updated` after a sign-in change. A lifetime change restates the
 * current usage, so a usage restored from an earlier run (or read under the estimate) stops promising an expiry the
 * cache no longer has.
 */
export class CodexUsage {
    /**
     * Minutes the cache survives an idle Chat (`codexCacheTtlMinutes`); none for a ChatGPT sign-in.
     */
    private cacheTtlMinutes: number | undefined = CODEX_CACHE_TTL_MINUTES;

    constructor(private readonly host: Pick<AgentChatSessionHost, 'apply' | 'read'>) {}

    private setCacheTtl(minutes: number | undefined): void {
        this.cacheTtlMinutes = minutes;
        const { model, usage } = this.host.read();
        if (!usage || usage.cacheTtlMinutes === minutes) return;
        const restated = { ...usage, cacheTtlMinutes: minutes };
        if (minutes === undefined) delete restated.cacheTtlMinutes;
        delete restated.cacheRewriteUsd;
        this.host.apply([
            { op: 'state', state: { usage: withCacheRewriteEstimate(restated, model) } },
        ]);
    }

    async loadSignIn(connection: JsonRpcConnection): Promise<void> {
        this.setCacheTtl(await readCodexCacheTtlMinutes(connection));
    }

    /**
     * Handles the notifications this owns, returning whether `method` was one of them.
     */
    onNotification(method: string, parameters: Record<string, unknown>): boolean {
        if (method === 'account/updated') {
            this.setCacheTtl(codexCacheTtlMinutes(stringField(parameters.authMode)));
            return true;
        }
        if (method !== 'thread/tokenUsage/updated') return false;
        const usage = mapCodexUsage(parameters, this.host.read().model, this.cacheTtlMinutes);
        if (usage) this.host.apply([{ op: 'state', state: { usage } }]);
        return true;
    }
}
