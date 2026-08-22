/**
 * Converts only the expected pre-creation `ENOENT` into a pending poll value. Playwright stops polling when the
 * callback rejects, so every other read failure must remain the causal error.
 */
export async function readFileForPoll(
    readResult: () => Promise<string>,
): Promise<string | undefined> {
    try {
        return await readResult();
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            Reflect.get(error, 'code') === 'ENOENT'
        ) {
            return undefined;
        }
        throw error;
    }
}
