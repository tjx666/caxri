import type { AgentChatModel, AgentChatModelChange, AgentChatSnapshot } from '@caxri/protocol';
import { findAgentChatModel } from '@caxri/protocol';

import { boundedChatModels, clip, isRecord, stringField } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import type { CodexPermissions } from './codex-permissions';
import type { JsonRpcConnection } from './json-rpc-connection';

const MODEL_LIST_TIMEOUT_MS = 10_000;

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
