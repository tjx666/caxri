import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatFinalReplyId, foldAgentChatTurn, isAgentChatItemVisible } from '@caxri/protocol';

/**
 * The expansion key of a finished turn's fold: the turn id for its first, suffixed by the segment index for each fold a
 * steered message started after it.
 */
export function agentChatFoldKey(turnId: string, segmentIndex: number): string {
    return segmentIndex === 0 ? turnId : `${turnId}:${segmentIndex}`;
}

/**
 * The expanded set after the user taps a turn's `Worked for` row or a delegated task's Show instruction. A turn fold's
 * key in the set flips its default, so it folds a fold that starts open (`isOpenByDefault`).
 */
export function toggleAgentChatExpansion(
    expandedIds: ReadonlySet<string>,
    turnId: string,
): ReadonlySet<string> {
    const next = new Set(expandedIds);
    if (!next.delete(turnId)) next.add(turnId);
    return next;
}

/**
 * The ids of the turns still running: the active turn and any turn the projection marks `running`.
 */
export function agentChatRunningTurnIds(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'turns'>,
): ReadonlySet<string> {
    const running = new Set(
        snapshot.turns.filter((turn) => turn.status === 'running').map((turn) => turn.id),
    );
    if (snapshot.activeTurnId !== undefined) running.add(snapshot.activeTurnId);
    return running;
}

/**
 * The expanded set once turns that were running (`previouslyRunning`) have ended. A reader who was not following the
 * latest output (`isFollowing` false) is reading earlier content, so a turn that ends under them stays open instead of
 * folding the work away mid-read, as Desktop keeps open a row the user opened while the turn ran. A reader following
 * the end sees the turn fold as usual. Returns `expandedIds` itself when nothing changes.
 */
export function holdEndedTurnsOpen(
    expandedIds: ReadonlySet<string>,
    previouslyRunning: ReadonlySet<string>,
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'>,
    isFollowing: boolean,
): ReadonlySet<string> {
    if (isFollowing) return expandedIds;
    const running = agentChatRunningTurnIds(snapshot);
    const ended = new Set(
        snapshot.turns
            .filter((turn) => previouslyRunning.has(turn.id) && !running.has(turn.id))
            .map((turn) => turn.id),
    );
    // Every fold of the turn stays open, including those its steered messages started; a key past its last fold is inert.
    // A fold already open by default is left out: its key would fold it instead.
    const openByDefault = new Set<string>();
    for (const turnId of ended) {
        const visible = snapshot.items.filter(
            (item) => item.turnId === turnId && isAgentChatItemVisible(item),
        );
        const parts = foldAgentChatTurn(visible, agentChatFinalReplyId(visible));
        for (const part of parts)
            if (part.kind === 'fold' && part.isOpenByDefault)
                openByDefault.add(agentChatFoldKey(turnId, part.segment.index));
    }
    const keys = [...ended].map((turnId) => agentChatFoldKey(turnId, 0));
    const segments = new Map<string, number>();
    for (const item of snapshot.items) {
        if (item.type !== 'userMessage' || item.turnId === undefined || !ended.has(item.turnId))
            continue;
        const index = (segments.get(item.turnId) ?? 0) + 1;
        segments.set(item.turnId, index);
        keys.push(agentChatFoldKey(item.turnId, index));
    }
    const added = keys.filter((key) => !expandedIds.has(key) && !openByDefault.has(key));
    if (added.length === 0) return expandedIds;
    return new Set([...expandedIds, ...added]);
}
