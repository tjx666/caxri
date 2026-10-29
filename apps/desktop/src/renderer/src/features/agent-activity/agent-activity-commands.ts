import { translate } from '../../i18n';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { getBootstrap } from '../../stores/selectors';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
import { didSelectSession } from '../session/session-commands';
import { agentActivityGroups, nextAgentAttentionSessionId } from './agent-activity-rows';

/**
 * Selects the next Session that needs the user, in the same order the Activity view lists them.
 *
 * Reads the store directly rather than the mounted view, so the shortcut works from anywhere, including while the
 * Primary Side Bar is hidden or showing the Project tree. With nothing waiting it is a deliberate no-op: a chord that
 * jumps somewhere arbitrary when the queue is empty is worse than one that does nothing.
 *
 * Landing on a Session also puts the queue on screen. The queue is the context this command navigates within: without
 * it the user gets a new selection and no way to see what else is in line, or what clearing this one left behind.
 */
export function focusNextAttentionSession(): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const groups = agentActivityGroups({
        now: Date.now(),
        projects: topLevelProjects(bootstrap.projects),
        sessions: bootstrap.sessions,
        t: translate,
        terminals: bootstrap.terminals,
    });
    const sessionId = nextAgentAttentionSessionId(groups, bootstrap.selectedSessionId);
    // Wrapping a one-entry queue lands back on the Session already selected. Re-selecting it changes nothing on screen
    // but runs the whole Server-side `session.select`: probes, interrupted-Terminal restore, a full state broadcast.
    if (!sessionId || sessionId === bootstrap.selectedSessionId) return;
    useChromeLayoutStore.getState().showPrimarySidebarActivity();
    // Fire-and-forget: `didSelectSession` funnels its own failures into a toast via `tryCommand`.
    void didSelectSession(sessionId);
}
