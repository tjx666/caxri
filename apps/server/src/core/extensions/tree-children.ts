import type { ExtensionViewEventContext, TreeChildrenResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

interface TreeChildrenParameters {
    viewId: string;
    parentHandle?: string;
    requestId: string;
    context: ExtensionViewEventContext;
}

function isGenerationExpired(error: unknown): error is { code: 'GENERATION_EXPIRED' } {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'GENERATION_EXPIRED'
    );
}

/**
 * Requests one tree level from the Extension Host, recovering from a concurrent provider refresh.
 *
 * A provider refresh can invalidate either an in-flight root request or a branch handle before its debounced
 * treeChanged event reaches the Renderer. Both races recover with a current root snapshot while every other Extension
 * Host rejection stays strict. A second refresh landing during that retry (a burst of watcher refreshes) supersedes the
 * read: its own treeChanged event re-reads the tree. It becomes CANCELLED because GENERATION_EXPIRED is not a public
 * wire code and otherwise reached the Renderer as INTERNAL, which production logged as a fault.
 */
export async function requestTreeChildren(
    request: (parameters: TreeChildrenParameters) => Promise<TreeChildrenResult>,
    parameters: TreeChildrenParameters,
): Promise<TreeChildrenResult> {
    try {
        return await request(parameters);
    } catch (error) {
        if (!isGenerationExpired(error)) throw error;
    }
    try {
        const root = await request({
            viewId: parameters.viewId,
            requestId: parameters.requestId,
            context: parameters.context,
        });
        return { ...root, ...(parameters.parentHandle && { reset: true }) };
    } catch (error) {
        if (isGenerationExpired(error))
            throw new CaxriError(
                'CANCELLED',
                error instanceof Error
                    ? error.message
                    : 'Tree provider refreshed while the request was running',
            );
        throw error;
    }
}
