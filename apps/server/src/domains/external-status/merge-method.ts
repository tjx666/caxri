import { z } from 'zod';

export type PullRequestMergeMethod = 'merge' | 'rebase' | 'squash';

/**
 * The `gh repo view --json` fields that decide which merge methods a repository accepts.
 */
export const REPO_MERGE_SETTINGS_FIELDS =
    'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed';

export const repoMergeSettingsSchema = z.object({
    squashMergeAllowed: z.boolean().optional(),
    mergeCommitAllowed: z.boolean().optional(),
    rebaseMergeAllowed: z.boolean().optional(),
});

/**
 * Squash first because it is what a repository that allows it almost always wants for agent-delivered branches; a
 * repository that disables it states its preference by what remains. The merge itself and the Status panel's pre-merge
 * preview both call this, so the method the confirmation names is the one the merge uses.
 */
export function chooseMergeMethod(
    settings: z.infer<typeof repoMergeSettingsSchema>,
): PullRequestMergeMethod | undefined {
    if (settings.squashMergeAllowed) return 'squash';
    if (settings.mergeCommitAllowed) return 'merge';
    if (settings.rebaseMergeAllowed) return 'rebase';
    return undefined;
}
