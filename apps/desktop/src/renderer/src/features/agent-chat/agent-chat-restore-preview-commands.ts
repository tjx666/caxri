import { caxri } from '../../lib/caxri';

/**
 * How long the revert confirmation waits for the provider's dry run before it opens without a file list.
 */
const PREVIEW_TIMEOUT_MS = 10_000;

/**
 * The preview fields of `agentChat.confirmRevertFiles`: the files a restore would revert, nothing when the provider has
 * no preview, or `previewFailed` when the dry run did not answer so the dialog can say so and stay usable.
 */
export type AgentChatRevertPreview = Pick<
    Parameters<typeof caxri.request<'agentChat.confirmRevertFiles'>>[1],
    'preview' | 'previewFailed'
>;

/**
 * Runs the read-only dry run for restoring code to message `itemId`. It never throws: the confirmation must open
 * whatever the dry run does, because the user can still decide to revert without a list.
 */
export async function previewAgentChatRevert(
    terminalId: string,
    itemId: string,
): Promise<AgentChatRevertPreview> {
    try {
        const result = await Promise.race([
            caxri.request('agentChat.previewRestoreFiles', { terminalId, itemId }),
            new Promise<never>((_resolve, reject) => {
                setTimeout(() => reject(new Error('preview timed out')), PREVIEW_TIMEOUT_MS);
            }),
        ]);
        if (!result.supported) return {};
        const { files, totalFiles, insertions, deletions } = result;
        return { preview: { files, totalFiles, insertions, deletions } };
    } catch {
        return { previewFailed: true };
    }
}
