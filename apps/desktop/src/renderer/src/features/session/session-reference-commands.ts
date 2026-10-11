import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';
import { formatSessionReference } from './session-reference';

/**
 * Asks the Server to condense another Session's conversation into a reference file and returns the text to insert, or
 * `undefined` after a toast when the Session has nothing to cite. The conversation itself never reaches the Renderer.
 */
export function prepareSessionReference(sessionId: string): Promise<string | undefined> {
    return tryCommand("Couldn't reference that Session", async () =>
        formatSessionReference(await caxri.request('session.conversationReference', { sessionId })),
    );
}
