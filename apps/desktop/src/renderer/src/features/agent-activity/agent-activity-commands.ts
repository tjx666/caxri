import type { ViewContainerId } from '@caxri/protocol';

import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { getBootstrap, getSessionState } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
import { didSelectSession } from '../session/session-commands';
import { agentActivityGroups, nextAgentAttentionSessionId } from './agent-activity-rows';

export const AGENT_ACTIVITY_CONTAINER_ID = 'caxri.activity' as ViewContainerId;

/**
 * Selects a Session from the Activity queue and keeps the queue on screen.
 *
 * The Secondary Side Bar's visible container is Session-owned state, so selecting another Session normally restores
 * whatever that Session last showed — which, for a list whose entire purpose is walking Sessions, means the list
 * disappears on its own first click. Re-asserting the container after the selection lands is what makes the queue
 * clickable, and the new Session keeps Activity the same way it would keep any container the user left open on it.
 *
 * Both conditions are load-bearing. Activity must be the Session's desired container _and_ the Secondary Side Bar must
 * actually be on screen: with the bar collapsed the user sees no queue to preserve, so `session.focusNextAttention`
 * would silently rewrite the target Session's stored container with nothing visible to explain it.
 */
export async function didSelectAgentActivitySession(sessionId: string): Promise<boolean> {
    const wasVisible =
        getSessionState()?.desiredSecondarySidebarViewContainerId === AGENT_ACTIVITY_CONTAINER_ID &&
        useChromeLayoutStore.getState().secondarySidebarVisible;
    const selected = await didSelectSession(sessionId);
    if (!selected || !wasVisible) return selected;
    /**
     * `setDesiredSecondarySidebarViewContainerId` writes to whichever Session is selected _now_, so a user who switched
     * Sessions from somewhere else while this request was in flight would otherwise have Activity written onto that
     * third Session instead.
     */
    if (getBootstrap()?.selectedSessionId !== sessionId) return selected;
    useSessionViewStore
        .getState()
        .setDesiredSecondarySidebarViewContainerId(AGENT_ACTIVITY_CONTAINER_ID);
    return selected;
}

/**
 * Selects the next Session that needs the user, in the same order the Activity view lists them.
 *
 * Reads the store directly rather than the mounted view, so the shortcut works from anywhere — including while the
 * Activity container has never been opened. With nothing waiting it is a deliberate no-op: a chord that jumps somewhere
 * arbitrary when the queue is empty is worse than one that does nothing.
 */
export function focusNextAttentionSession(): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const groups = agentActivityGroups({
        now: Date.now(),
        projects: topLevelProjects(bootstrap.projects),
        sessions: bootstrap.sessions,
        terminals: bootstrap.terminals,
    });
    const sessionId = nextAgentAttentionSessionId(groups, bootstrap.selectedSessionId);
    // Wrapping a one-entry queue lands back on the Session already selected. Re-selecting it changes nothing on screen
    // but runs the whole Server-side `session.select` — probes, interrupted-Terminal restore, a full state broadcast.
    if (!sessionId || sessionId === bootstrap.selectedSessionId) return;
    // Fire-and-forget: `didSelectSession` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void didSelectAgentActivitySession(sessionId);
}
