import { caxri } from '../../lib/caxri';

/**
 * Tells Desktop Main which Session this window renders. Main adds the window's native focus, visibility, and minimize
 * state and forwards the whole row to the Server (suspension, watching, and polling follow what is visible), so the
 * Renderer supplies only the one fact it owns and can never claim focus it does not have.
 *
 * Best effort: presence is reseeded by Main on every reconnect and by the next report, so a failed call needs no retry
 * and must not toast. Main logs a failure that is not simply a lost connection.
 */
export async function reportViewedSession(sessionId: string | null): Promise<void> {
    try {
        await caxri.request('window.reportViewing', { viewingSessionId: sessionId });
    } catch {
        // Covered by the next report or reseed; see above.
    }
}
