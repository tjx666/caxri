import { translate } from '../../i18n';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import { showConfirm } from '../../stores/confirmations';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { topLevelProjects } from '../primary-sidebar/project-visibility';
import { didSelectSession, markSessionsDone } from '../session/session-commands';
import {
    agentActivityGroups,
    agentAttentionMarkDoneEntries,
    nextAgentAttentionSessionId,
} from './agent-activity-rows';

/**
 * The Activity groups computed from the store, the same ones the view renders.
 */
function currentAgentActivityGroups() {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    return {
        bootstrap,
        groups: agentActivityGroups({
            projects: topLevelProjects(bootstrap.projects),
            selectedSessionId: bootstrap.selectedSessionId,
            sessions: bootstrap.sessions,
            terminals: bootstrap.terminals,
        }),
    };
}

/**
 * Marks every Session in Needs attention done after one confirmation, from the Needs attention heading or the Command
 * Palette. Each Session is resolved at the attention generation the queue showed, so one whose Agent started a newer
 * turn since stays pending. Like {@link focusNextAttentionSession}, it reads the store rather than the mounted view.
 */
export async function markAllAttentionSessionsDone(): Promise<void> {
    const current = currentAgentActivityGroups();
    if (!current) return;
    const entries = agentAttentionMarkDoneEntries(current.groups);
    if (entries.length === 0) return;
    const isConfirmed = await showConfirm({
        confirmLabel: translate('agentActivity.markAllDone.confirm'),
        message: translate(
            entries.length === 1
                ? 'agentActivity.markAllDone.messageOne'
                : 'agentActivity.markAllDone.messageOther',
            { count: entries.length },
        ),
        title: translate('agentActivity.markAllDone.title'),
    });
    if (!isConfirmed) return;
    await tryCommand(translate('agentActivity.markAllDone.failed'), () =>
        markSessionsDone(entries),
    );
}

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
    const current = currentAgentActivityGroups();
    if (!current) return;
    const { bootstrap, groups } = current;
    const sessionId = nextAgentAttentionSessionId(groups, bootstrap.selectedSessionId);
    // Wrapping a one-entry queue lands back on the Session already selected. Re-selecting it changes nothing on screen
    // but runs the whole Server-side `session.select`: probes, interrupted-Terminal restore, a full state broadcast.
    if (!sessionId || sessionId === bootstrap.selectedSessionId) return;
    useChromeLayoutStore.getState().showPrimarySidebarActivity();
    // Fire-and-forget: `didSelectSession` funnels its own failures into a toast via `tryCommand`.
    void didSelectSession(sessionId);
}
