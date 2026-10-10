import type {
    AgentChatModel,
    AgentChatModelChange,
    AgentChatModelRequest,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { findAgentChatModel } from '@caxri/protocol';

import { boundedChatModels, clip, isRecord, stringField } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import type { CodexConnection } from './codex-connection';

const MODEL_LIST_TIMEOUT_MS = 10_000;

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
        models.push({
            id,
            displayName: stringField(entry.displayName) ?? id,
            ...(description && { description }),
            efforts,
            ...(defaultEffort && { defaultEffort }),
        });
    }
    return boundedChatModels(models);
}

/**
 * One Codex Chat's model and effort: what the provider lists and reports, and the switch still waiting for a turn.
 * App-server has no request that changes them in place; they ride on the next `turn/start`, which Codex then keeps for
 * the turns after it and saves on the thread.
 */
export class CodexModelSettings {
    private nextTurn: AgentChatModelRequest = {};

    constructor(private readonly host: Pick<AgentChatSessionHost, 'apply' | 'read'>) {}

    /**
     * Records the effort `thread/start` or `thread/resume` reported for the thread. A thread that reports none uses its
     * model's default, which `load` fills in; clearing it here drops a choice shown before a restart that never reached
     * a turn, so the composer does not claim an effort Codex is not using.
     */
    reportOpened(effort: string | undefined): void {
        this.host.apply([{ op: 'state', state: { effort: effort ? clip(effort, 40) : null } }]);
    }

    /**
     * The snapshot state the started thread adds: the models this account can switch to, and the model's default effort
     * for a thread that never chose one. A Codex that cannot list models still chats; the composer then shows the model
     * in use as plain text.
     */
    async load(connection: CodexConnection): Promise<Pick<AgentChatSnapshot, 'effort' | 'models'>> {
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
    configure({ model, effort }: AgentChatModelChange): void {
        const change = { ...(model && { model: model.id }), ...(effort && { effort }) };
        this.nextTurn = { ...this.nextTurn, ...change };
        this.host.apply([{ op: 'state', state: change }]);
    }

    /**
     * Sends `turn/start` with the pending switch. Codex holds the choice once the request succeeds; a choice made while
     * it was in flight stays pending for the turn after.
     */
    async startTurn(
        connection: CodexConnection,
        parameters: Record<string, unknown>,
        timeoutMs: number,
    ): Promise<unknown> {
        const pending = this.nextTurn;
        const result = await connection.request(
            'turn/start',
            { ...parameters, ...pending },
            timeoutMs,
        );
        if (this.nextTurn === pending) this.nextTurn = {};
        return result;
    }
}
