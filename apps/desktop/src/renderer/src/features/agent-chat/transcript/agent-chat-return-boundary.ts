import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { isAgentChatItemVisible } from '@caxri/protocol';

import { isSubpixelShrink } from '../../../lib/subpixel-shrink';

/**
 * The window of time the user was away from a Session: `boundary` is when they last looked at it, `capturedAt` is when
 * they came back. Turns that finish after `capturedAt` happen in front of the user and are not "new" to them.
 */
export interface AgentChatReturnWindow {
    boundary: number;
    capturedAt: number;
}

/**
 * When a turn ended, or `undefined` while it runs or when the provider reported no timing (replayed history).
 */
function turnEndedAt(turn: AgentChatTurn): number | undefined {
    if (turn.status === 'running') return undefined;
    if (turn.startedAt === undefined || turn.durationMs === undefined) return undefined;
    return turn.startedAt + turn.durationMs;
}

/**
 * The Agent turns that finished while the user was away, in snapshot order. A turn counts by its own end time, never by
 * the Session's attention epoch, which also moves for a permission request or a question within one turn.
 */
export function turnsFinishedDuringAbsence(
    turns: readonly AgentChatTurn[],
    window: AgentChatReturnWindow,
): AgentChatTurn[] {
    return turns.filter((turn) => {
        const endedAt = turnEndedAt(turn);
        return endedAt !== undefined && endedAt > window.boundary && endedAt <= window.capturedAt;
    });
}

/**
 * The first turn the user missed, to jump to where it begins; `undefined` when no turn was missed or none of its
 * visible items is loaded. Its prompt opens it when the user sent one, while a turn a background task or `/goal`
 * started opens on whatever it showed first (`AGENT_CHAT_TURN_START_ATTRIBUTE`).
 */
export function agentChatReturnAnchorTurnId(
    items: readonly AgentChatItem[],
    turns: readonly AgentChatTurn[],
    window: AgentChatReturnWindow,
): string | undefined {
    const first = turnsFinishedDuringAbsence(turns, window).at(0);
    if (!first) return undefined;
    return items.some((item) => item.turnId === first.id && isAgentChatItemVisible(item))
        ? first.id
        : undefined;
}

/**
 * Whether the first missed turn's opening entry sits wholly above the scroll view, given both elements' client rects.
 * When that entry is the prompt, what the user missed is the Agent's reply, which starts where the prompt ends, so the
 * bottom edge decides: a long prompt whose top has scrolled away while its end and the reply below it are on screen is
 * already in view.
 */
export function isAgentChatReturnAnchorAbove(
    anchor: Pick<DOMRect, 'bottom'>,
    view: Pick<DOMRect, 'top'>,
): boolean {
    return anchor.bottom <= view.top;
}

/**
 * Whether the return hint shows now. It only helps while the start of what the user missed is out of view above: one
 * missed turn longer than the view still needs a way back to its prompt, while two short ones may sit fully on screen.
 * It shares the bottom slot with Jump to latest, which shows only once the latest entry leaves the view, so the two
 * never overlap. When the first missed turn is not loaded (`isAnchorAbove` is `undefined`), the hint has nothing to
 * jump to and only reports a count worth knowing: two turns or more.
 */
export function isAgentChatReturnHintShown({
    count,
    isAnchorAbove,
    isLatestInView,
}: {
    count: number;
    isAnchorAbove: boolean | undefined;
    isLatestInView: boolean;
}): boolean {
    if (count === 0 || !isLatestInView) return false;
    return isAnchorAbove ?? count >= 2;
}

/**
 * The room kept below the transcript for the return hint, which floats `bottom-2` over the view's end.
 */
export const AGENT_CHAT_RETURN_HINT_SLOT_PX = 40;

/**
 * The height of the slot after the transcript that keeps the return hint off the last line. While the hint shows, the
 * slot holds the hint's room. Once it clears, the slot keeps only the part still at or above the view's bottom
 * (`viewBottom - slotTop`, both in the scroll content's coordinates), so scrolling back consumes it and it never grows
 * back. Dropping it at once would shorten the content under a view resting at its end, and the browser would clamp the
 * view, shifting the whole transcript down as the hint fades. A shrink that is only measurement noise keeps `height`
 * ({@link isSubpixelShrink}); otherwise a view of fractional height slid one device pixel per frame until the slot was
 * gone.
 */
export function agentChatReturnHintSlotHeight({
    height,
    isShown,
    slotTop,
    viewBottom,
}: {
    /**
     * The slot's laid-out height before this measurement.
     */
    height: number;
    isShown: boolean;
    slotTop: number;
    viewBottom: number;
}): number {
    if (isShown) return AGENT_CHAT_RETURN_HINT_SLOT_PX;
    const next = Math.max(Math.min(height, viewBottom - slotTop), 0);
    return isSubpixelShrink(height, next) ? height : next;
}
