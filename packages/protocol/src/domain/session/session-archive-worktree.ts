import { z } from 'zod';

import { sessionPullRequestStateSchema } from '../session-pull-request.js';

/**
 * The user's answer to the archive confirmation: remove the Session's worktree even though its pull request is not
 * merged, or archive and keep it.
 */
export const sessionArchiveWorktreeChoiceSchema = z.enum(['remove', 'keep']);

/**
 * The worktree archiving a Session would remove, or `null` when there is nothing to remove: the setting is off, or the
 * Session's Workbench Root is not a worktree Caxri registered on its Project's behalf, or another open Session still
 * works in it.
 *
 * - `automatic`: the pull request is merged, so archiving removes the worktree without asking.
 * - `confirm`: no merged pull request, so archiving keeps the worktree unless the user chooses `remove`.
 */
export const sessionArchiveWorktreePlanSchema = z.object({
    worktree: z
        .object({
            /**
             * Checked-out branch, which survives the removal. A detached worktree never qualifies.
             */
            branch: z.string(),
            /**
             * Absolute worktree root, shown so the user knows which folder is deleted.
             */
            rootPath: z.string(),
            removal: z.enum(['automatic', 'confirm']),
            pullRequestState: sessionPullRequestStateSchema.optional(),
        })
        .nullable(),
});

/**
 * What the native archive confirmation names: the Session, the folder it deletes, and why it asks.
 */
export const sessionArchiveWorktreeConfirmationSchema = z.object({
    sessionTitle: z.string().max(500),
    branch: z.string().min(1).max(1_000),
    rootPath: z.string().min(1).max(4_096),
    pullRequestState: sessionPullRequestStateSchema.optional(),
});

export type SessionArchiveWorktreeChoice = z.infer<typeof sessionArchiveWorktreeChoiceSchema>;
export type SessionArchiveWorktreePlan = z.infer<typeof sessionArchiveWorktreePlanSchema>;
export type SessionArchiveWorktreeConfirmation = z.infer<
    typeof sessionArchiveWorktreeConfirmationSchema
>;
