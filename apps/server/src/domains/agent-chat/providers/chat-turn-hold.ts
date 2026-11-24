import type { TurnHoldReleaseReason } from '@caxri/protocol';

/**
 * A held turn's transition, content-free: a provider holds a turn's end open while a foreground command still runs
 * (Antigravity). `AgentChatSessionHost.onTurnHold` (optional: only a provider that holds turns reports it) receives how
 * many calls hold the turn, or why and after how long it ended.
 */
export type ChatTurnHoldEvent =
    | { kind: 'held'; holdingCalls: number }
    | { kind: 'released'; reason: TurnHoldReleaseReason; holdMs: number };

/**
 * The host callback a turn-holding provider reports through; `AgentChatSessionHost` extends it.
 */
export interface ChatTurnHoldHost {
    onTurnHold?(event: ChatTurnHoldEvent): void;
}
