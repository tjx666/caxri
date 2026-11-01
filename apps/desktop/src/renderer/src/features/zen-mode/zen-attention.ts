/**
 * The words behind the Zen Mode attention dot, or `undefined` when no Session needs the user and the dot stays away.
 */
export function zenAttentionMessage(
    count: number,
): { key: 'workbench.zenAttentionOne' | 'workbench.zenAttentionOther'; count: number } | undefined {
    if (count <= 0) return undefined;
    return {
        key: count === 1 ? 'workbench.zenAttentionOne' : 'workbench.zenAttentionOther',
        count,
    };
}
