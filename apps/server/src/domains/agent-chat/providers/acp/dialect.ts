import type { AgentChatSnapshot, AgentChatTurn, AgentProvider } from '@caxri/protocol';

import type { AcpToolCall, AcpToolPresentation } from './items';
import type { AcpQuestionDialect } from './requests';

type Json = Record<string, unknown>;

export interface AcpActiveTurn {
    id: string;
    startedAt: number;
    isCompaction: boolean;
    /**
     * Which `session/prompt` request carries the turn now. An agent that takes a mid-turn message as a new prompt ends
     * the earlier request on its own, and that request's answer no longer ends the turn (see
     * `AcpChatSession.supersedePrompt`).
     */
    prompt: number;
    /**
     * Settle every `interrupt()` waiting for the cancelled prompt to answer; a repeated Stop adds another.
     */
    onFinished: Array<() => void>;
}

/**
 * What differs between ACP agents at the level a session needs before it opens: its name in errors, its tool titles,
 * and its extensions to the update and request streams.
 */
export interface AcpDialect {
    provider: AgentProvider;
    /**
     * The agent's name in errors, e.g. `Grok Build`.
     */
    label: string;
    presentation: AcpToolPresentation;
    questions?: AcpQuestionDialect;
    displayText?: (content: Json | undefined) => string | undefined;
    configState?: (configOptions: unknown) => Partial<AgentChatSnapshot> | undefined;
    /**
     * The status a replayed turn the agent did not mark finished gets; see `AcpUpdates.endReplay`.
     */
    settledReplayTurns: AgentChatTurn['status'];
    /**
     * Whether `session/prompt` takes image content blocks (the agent's `promptCapabilities.image`).
     */
    images?: boolean;
    /**
     * The plan a finished tool call proposes for approval in plan mode, if it is one, such as Antigravity writing its
     * plan artifact with a feedback request. The Chat shows it as a proposed plan, which offers Start Building.
     */
    proposedPlan?: (call: AcpToolCall) => string | undefined;
    /**
     * Whether a failed prompt's error message is the agent refusing the turn because the plan's quota is used up.
     */
    isUsageLimitError?: (message: string) => boolean;
    /**
     * Whether a still-running tool call keeps the turn open after its prompt answered, for an agent that ends a prompt
     * while a foreground command it moved to the background still runs; see `AcpRunningTools`.
     */
    shouldHoldTurn?: (call: AcpToolCall) => boolean;
}
