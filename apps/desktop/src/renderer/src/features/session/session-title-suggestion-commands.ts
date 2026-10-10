import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Asks the Server for a title generated from the Session's Agent conversation. Failures surface as a toast and resolve
 * to `undefined`; the caller decides whether to commit the suggestion through `didRenameSession`.
 */
export function suggestSessionTitle(sessionId: string): Promise<string | undefined> {
    return tryCommand("Couldn't name this Session", async () => {
        const { displayTitle } = await caxri.request('session.suggestTitle', { sessionId });
        return displayTitle;
    });
}
