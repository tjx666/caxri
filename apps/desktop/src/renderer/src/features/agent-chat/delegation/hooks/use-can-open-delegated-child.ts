import { useHasSessionTerminal, useSessionById } from '../../../../stores/selectors';
import { canOpenDelegatedChild } from '../side-view/delegated-child-opener';

/**
 * Whether a row naming the delegated child `sessionId` opens it: the Workbench still lists the Session, and it has
 * something to show (see {@link canOpenDelegatedChild}). Shared by the strip row, the timeline record, and the notice
 * row, so the three surfaces naming one child never disagree.
 */
export function useCanOpenDelegatedChild(sessionId: string, isFailed: boolean): boolean {
    const isListed = useSessionById(sessionId) !== undefined;
    const hasTerminal = useHasSessionTerminal(sessionId);
    return isListed && canOpenDelegatedChild({ hasTerminal, isFailed });
}
