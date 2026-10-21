import type {
    AgentChatItem,
    AgentChatModel,
    AgentChatModelChange,
    AgentChatPatchOperation,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { findAgentChatModel } from '@caxri/protocol';

import { ChatTurnUsage, codexTurnResponse } from '../usage';
import { boundedChatModels, clip, isRecord, stringField } from './chat-items';
import type { AgentChatDefaultsSave, AgentChatSessionHost } from './chat-provider';
import { withCacheRewriteEstimate } from './chat-usage';
import { TURN_REQUEST_TIMEOUT_MS } from './codex-delivery-check';
import { mapCodexUsage } from './codex-items';
import type { CodexPermissions } from './codex-permissions';
import type { JsonRpcConnection } from './json-rpc-connection';

const MODEL_LIST_TIMEOUT_MS = 10_000;

type AgentChatNoticeCompaction = NonNullable<
    Extract<AgentChatItem, { type: 'notice' }>['compaction']
>;

/**
 * The service tier ids that mean Fast mode. `model/list` names the tier `priority` (its wire value); Codex also accepts
 * the config spelling `fast` for it, and reports back whichever was sent.
 */
const FAST_SERVICE_TIERS = new Set(['priority', 'fast']);
const FAST_SERVICE_TIER = 'priority';
/**
 * The service tier that asks for standard speed. Clearing the tier with `null` would fall back to the user's
 * `config.toml` or the model's catalog default instead, which may itself be Fast.
 */
const STANDARD_SERVICE_TIER = 'default';

const CONFIG_WRITE_TIMEOUT_MS = 10_000;

/**
 * The `config.toml` edits that make a picker switch the default for new Codex threads, in the keys and spellings
 * Codex's TUI writes for the same choices (`config_update.rs`): `model`, `model_reasoning_effort`, and `service_tier`
 * as `fast` or `default`. Only what the switch changed is written.
 */
function codexDefaultEdits({
    model,
    effort,
    fast,
}: AgentChatModelChange): Array<{ keyPath: string; value: string; mergeStrategy: 'replace' }> {
    const values: Array<[string, string | undefined]> = [
        ['model', model?.id],
        ['model_reasoning_effort', effort],
        ['service_tier', fast === undefined ? undefined : fast ? 'fast' : 'default'],
    ];
    return values.flatMap(([keyPath, value]) =>
        value === undefined ? [] : [{ keyPath, value, mergeStrategy: 'replace' as const }],
    );
}

/**
 * Whether a model offers Fast mode, with Codex's description of it (`1.5x speed, increased usage`). `serviceTiers`
 * replaced `additionalSpeedTiers`, which older app-servers still send alone.
 */
function codexFastTier(entry: Record<string, unknown>): AgentChatModel['fast'] {
    if (Array.isArray(entry.serviceTiers)) {
        const tiers: unknown[] = entry.serviceTiers;
        const tier = tiers.find(
            (candidate) =>
                isRecord(candidate) && FAST_SERVICE_TIERS.has(stringField(candidate.id) ?? ''),
        );
        if (!isRecord(tier)) return undefined;
        const description = stringField(tier.description);
        return description ? { description: clip(description, 200) } : {};
    }
    return Array.isArray(entry.additionalSpeedTiers) && entry.additionalSpeedTiers.includes('fast')
        ? {}
        : undefined;
}

/**
 * Maps a `model/list` page to the models a Chat can switch to. `model` is the slug `turn/start` takes and
 * `thread/start` reports back, so it is the identifier; hidden models are already excluded by the request.
 */
function codexChatModels(result: unknown): AgentChatModel[] {
    const data = isRecord(result) && Array.isArray(result.data) ? result.data : [];
    const models: AgentChatModel[] = [];
    for (const entry of data) {
        if (!isRecord(entry)) continue;
        const id = stringField(entry.model) ?? stringField(entry.id);
        if (!id) continue;
        const efforts = Array.isArray(entry.supportedReasoningEfforts)
            ? entry.supportedReasoningEfforts.flatMap((option) => {
                  const effort = isRecord(option) ? stringField(option.reasoningEffort) : undefined;
                  return effort ? [effort] : [];
              })
            : [];
        const defaultEffort = stringField(entry.defaultReasoningEffort);
        const description = stringField(entry.description);
        const fast = codexFastTier(entry);
        models.push({
            id,
            displayName: stringField(entry.displayName) ?? id,
            ...(description && { description }),
            efforts,
            ...(defaultEffort && { defaultEffort }),
            ...(fast && { fast }),
        });
    }
    return boundedChatModels(models);
}

/**
 * The `turn/start` fields a pending switch sets: the model, effort, and service tier.
 */
interface CodexTurnSettings {
    model?: string;
    effort?: string;
    serviceTier?: string;
}

/**
 * One Codex Chat's model, effort, and Fast mode: what the provider lists and reports, and the switch still waiting for
 * a turn. App-server has no request that changes them in place; they ride on the next `turn/start`, which Codex then
 * keeps for the turns after it and saves on the thread.
 */
export class CodexModelSettings {
    private nextTurn: CodexTurnSettings = {};

    constructor(
        private readonly host: Pick<AgentChatSessionHost, 'apply' | 'read'>,
        private readonly permissions: CodexPermissions,
    ) {}

    /**
     * Records the effort and service tier `thread/start` or `thread/resume` reported for the thread. A thread that
     * reports no effort uses its model's default, which `load` fills in; clearing it here drops a choice shown before a
     * restart that never reached a turn, so the composer does not claim an effort Codex is not using. Fast mode is on
     * only while the thread's tier is the Fast one.
     */
    reportOpened({ effort, serviceTier }: { effort?: string; serviceTier?: string }): void {
        const isFast = serviceTier !== undefined && FAST_SERVICE_TIERS.has(serviceTier);
        this.host.apply([
            { op: 'state', state: { effort: effort ? clip(effort, 40) : null, fast: isFast } },
        ]);
    }

    /**
     * The snapshot state the started thread adds: the models this account can switch to, and the model's default effort
     * for a thread that never chose one. A Codex that cannot list models still chats; the composer then shows the model
     * in use as plain text.
     */
    async load(
        connection: JsonRpcConnection,
    ): Promise<Pick<AgentChatSnapshot, 'effort' | 'models'>> {
        let models: AgentChatModel[] = [];
        try {
            models = codexChatModels(
                await connection.request('model/list', { limit: 50 }, MODEL_LIST_TIMEOUT_MS),
            );
        } catch {
            // Listing is optional; the Chat keeps working without a picker.
        }
        const snapshot = this.host.read();
        const effort =
            snapshot.effort === undefined
                ? findAgentChatModel(models, snapshot.model)?.defaultEffort
                : undefined;
        return { ...(models.length > 0 && { models }), ...(effort && { effort }) };
    }

    /**
     * Holds a validated switch for the next turn and shows it right away.
     */
    configure({ model, effort, fast }: AgentChatModelChange): void {
        this.nextTurn = {
            ...this.nextTurn,
            ...(model && { model: model.id }),
            ...(effort && { effort }),
            ...(fast !== undefined && {
                serviceTier: fast ? FAST_SERVICE_TIER : STANDARD_SERVICE_TIER,
            }),
        };
        this.host.apply([
            {
                op: 'state',
                state: {
                    ...(model && { model: model.id }),
                    ...(effort && { effort }),
                    ...(fast !== undefined && { fast }),
                },
            },
        ]);
    }

    /**
     * Writes a picker switch to the user's `config.toml` through `config/batchWrite`, so a new Chat starts with it. A
     * thread reads these defaults only when it starts, so the open thread keeps the switch from {@link configure}.
     */
    async saveDefaults(
        connection: JsonRpcConnection,
        change: AgentChatModelChange,
    ): Promise<AgentChatDefaultsSave> {
        const edits = codexDefaultEdits(change);
        if (edits.length === 0) return { keys: [], isOverridden: false };
        const result = await connection.request(
            'config/batchWrite',
            { edits },
            CONFIG_WRITE_TIMEOUT_MS,
        );
        return {
            keys: edits.map(({ keyPath }) => keyPath),
            isOverridden: isRecord(result) && result.status === 'okOverridden',
        };
    }

    /**
     * Sends `turn/start` with the pending switches, including the permission level and plan mode. Codex holds them once
     * the request succeeds; a choice made while it was in flight stays pending for the turn after.
     */
    async startTurn(
        connection: JsonRpcConnection,
        parameters: Record<string, unknown>,
        timeoutMs: number,
    ): Promise<unknown> {
        const pending = this.nextTurn;
        const snapshot = this.host.read();
        const turn = this.permissions.turnParameters({
            model: pending.model ?? snapshot.model,
            effort: pending.effort ?? snapshot.effort,
        });
        const result = await connection.request(
            'turn/start',
            { ...parameters, ...pending, ...turn.parameters },
            timeoutMs,
        );
        if (this.nextTurn === pending) this.nextTurn = {};
        turn.commit();
        return result;
    }
}

/**
 * How long Codex's prompt cache is assumed to survive an idle Chat, in minutes, for an account that pays per request
 * (an API key, Amazon Bedrock). OpenAI's default retention is 30 minutes, longer only when a request opts into 12-hour
 * caching, and the CLI reports neither the policy nor an expiry, so this is an estimate that only drives the composer's
 * cache hint.
 *
 * @see https://developers.openai.com/api/docs/guides/prompt-caching
 */
const CODEX_CACHE_TTL_MINUTES = 30;

const ACCOUNT_READ_TIMEOUT_MS = 5_000;

/**
 * The cache lifetime for a Codex sign-in mode, as `account/read` (`account.type`) or `account/updated` (`authMode`)
 * names it. A ChatGPT sign-in keeps its cache with no expiry: since 2026-10-21 OpenAI keeps the cache of signed-in
 * Codex users forever, so returning to an old conversation never re-reads it at full price, and an expiry hint would be
 * wrong. Any other mode, and a mode Codex did not report, keeps the 30-minute estimate.
 *
 * @see https://x.com/thsottiaux/status/2112712984644784534
 */
function codexCacheTtlMinutes(authMode: string | undefined): number | undefined {
    return authMode === 'chatgpt' || authMode === 'chatgptAuthTokens'
        ? undefined
        : CODEX_CACHE_TTL_MINUTES;
}

/**
 * Reads the Chat's sign-in mode with `account/read` and returns its cache lifetime. A Codex that cannot answer keeps
 * the estimate rather than failing the Chat's start.
 */
async function readCodexCacheTtlMinutes(
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
 * A Codex Chat's context usage and running turn's spend (`thread/tokenUsage/updated`) and the prompt cache lifetime its
 * sign-in grants, kept current from `account/read` at start and `account/updated` after a sign-in change. A lifetime
 * change restates the current usage, so a usage restored from an earlier run (or read under the estimate) stops
 * promising an expiry the cache no longer has.
 */
export class CodexUsage {
    /**
     * Minutes the cache survives an idle Chat (`codexCacheTtlMinutes`); none for a ChatGPT sign-in.
     */
    private cacheTtlMinutes: number | undefined = CODEX_CACHE_TTL_MINUTES;
    private readonly turnUsage = new ChatTurnUsage();
    /**
     * Whether the next compaction is the user's `/compact` rather than Codex's own near the context limit.
     */
    private isManualCompactionNext = false;
    /**
     * The running compaction, from its `contextCompaction` start to its completion.
     */
    private compaction:
        { beforeTokens: number | undefined; trigger: 'auto' | 'manual' } | undefined;

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

    /**
     * Runs the user's `/compact`. Codex runs compaction as its own turn, so the usual turn and `contextCompaction`
     * events report it.
     */
    async compact(connection: JsonRpcConnection, threadId: string | undefined): Promise<void> {
        this.isManualCompactionNext = true;
        try {
            await connection.request('thread/compact/start', { threadId }, TURN_REQUEST_TIMEOUT_MS);
        } catch (error) {
            this.isManualCompactionNext = false;
            throw error;
        }
    }

    /**
     * The patch for a `contextCompaction` item (`item` is its mapped notice, absent while it runs). Codex reports no
     * sizes with it, but restates the usage from its estimate of the compacted history (`recompute_token_usage` in
     * `codex-rs/core/src/compact.rs`) just before the item completes, so the usage when it started and the usage at
     * completion bracket the compaction, as Claude Code's `compact_metadata` reports them.
     */
    compactionOperations(
        item: AgentChatItem | undefined,
        isStarted: boolean,
    ): AgentChatPatchOperation[] {
        const tokens = this.host.read().usage?.totalTokens;
        if (isStarted) {
            const trigger = this.isManualCompactionNext ? 'manual' : 'auto';
            this.compaction = { beforeTokens: tokens, trigger };
            this.isManualCompactionNext = false;
            return [{ op: 'state', state: { operation: 'compacting' } }];
        }
        const started = this.compaction;
        this.compaction = undefined;
        const compaction: AgentChatNoticeCompaction | undefined = started && {
            trigger: started.trigger,
            ...(started.beforeTokens !== undefined &&
                tokens !== undefined && {
                    beforeTokens: started.beforeTokens,
                    afterTokens: tokens,
                }),
        };
        const notice = compaction && item?.type === 'notice' ? { ...item, compaction } : item;
        return [
            ...(notice ? [{ op: 'upsertItem' as const, item: notice }] : []),
            { op: 'state', state: { operation: null } },
        ];
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
        const snapshot = this.host.read();
        const usage = mapCodexUsage(parameters, snapshot.model, this.cacheTtlMinutes);
        if (usage) this.host.apply([{ op: 'state', state: { usage } }]);
        const turnId = stringField(parameters.turnId);
        // A late report of a finished turn must not land on the next one.
        if (!turnId || turnId === snapshot.activeTurnId)
            this.turnUsage.record(
                this.host,
                codexTurnResponse(parameters, snapshot.model, snapshot.fast === true),
            );
        return true;
    }
}
