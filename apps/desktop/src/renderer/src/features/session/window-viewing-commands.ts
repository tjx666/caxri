import { caxri } from '../../lib/caxri';
import { environmentOfSession } from '../../lib/environment-routing';
import { environmentIdOf, useEnvironmentStore } from '../../stores/environment';

/**
 * Tells Desktop Main which Session this window renders. Main adds the window's native focus, visibility, and minimize
 * state and forwards the whole row to the Server (suspension, watching, and polling follow what is visible), so the
 * Renderer supplies only the one fact it owns and can never claim focus it does not have.
 *
 * Every machine the window reaches keeps its own presence: the Session's own Server hears its id, and every other
 * connected one hears `null`, so a Session on this Mac stops counting as visible once the user moves to an SSH Host's.
 *
 * Best effort: presence is reseeded by Main on every reconnect and by the next report, so a failed call needs no retry
 * and must not toast. Main logs a failure that is not simply a lost connection.
 */
export async function reportViewedSession(sessionId: string | null): Promise<void> {
    const owner = sessionId === null ? undefined : environmentOfSession(sessionId);
    const connected = useEnvironmentStore
        .getState()
        .hosts.filter((host) => host.phase === 'connected')
        .map(environmentIdOf);
    await Promise.all(
        [undefined, ...connected].map(async (environmentId) => {
            try {
                await caxri.in(environmentId).request('window.reportViewing', {
                    viewingSessionId: environmentId === owner ? sessionId : null,
                });
            } catch {
                // Covered by the next report or reseed; see above.
            }
        }),
    );
}
