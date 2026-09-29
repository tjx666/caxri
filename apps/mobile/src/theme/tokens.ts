import { diffStatColors, draculaTheme } from '@caxri/protocol';

export interface MobileTheme {
    background: string;
    border: string;
    danger: string;
    /**
     * The `+N -M` changed-line counts, matching Desktop's `--diff-stat-added` / `--diff-stat-removed`: `success` and
     * `danger` moved to one lightness so neither count reads heavier (see `diffStatColors`).
     */
    diffStatAdded: string;
    diffStatRemoved: string;
    /**
     * Raised controls and pills that sit on `surface`.
     */
    elevated: string;
    /**
     * Working-tree decoration for an added file, matching Desktop's `--git-added` token. Deliberately distinct from
     * `success`, which also identifies an open pull request.
     */
    gitAdded: string;
    /**
     * Working-tree decoration for a conflicted file, matching Desktop's `--git-conflicting` token.
     */
    gitConflicting: string;
    /**
     * Working-tree decoration for a deleted file, matching Desktop's `--git-deleted` token.
     */
    gitDeleted: string;
    /**
     * Working-tree decoration for a modified file, matching Desktop's `--git-modified` token. Deliberately distinct
     * from `warning`, which also identifies a degraded connection.
     */
    gitModified: string;
    /**
     * Working-tree decoration for an untracked file, matching Desktop's `--git-untracked` token. A renamed file shares
     * this role rather than `accent`, mirroring Desktop's `gitDecorationClassName` (VS Code's two decoration defaults
     * resolve to the same green).
     */
    gitUntracked: string;
    /**
     * Landed work, such as a merged pull request, matching Desktop's `merged` token.
     */
    merged: string;
    muted: string;
    primary: string;
    primaryForeground: string;
    success: string;
    surface: string;
    text: string;
    /**
     * Unread attention, matching Desktop's amber attention slot.
     */
    warning: string;
}

/**
 * Phase one deliberately shares Desktop's canonical Dracula palette. Keeping the semantic mapping here preserves a
 * single mobile theme entry point while appearance modes remain a later product decision.
 */
const diffStat = diffStatColors(draculaTheme.colors.success, draculaTheme.colors.danger);

export const mobileTheme = {
    background: draculaTheme.colors.background,
    border: draculaTheme.colors.border,
    danger: draculaTheme.colors.danger,
    diffStatAdded: diffStat.added,
    diffStatRemoved: diffStat.removed,
    elevated: draculaTheme.colors.elevated,
    gitAdded: draculaTheme.colors.gitAdded,
    gitConflicting: draculaTheme.colors.gitConflicting,
    gitDeleted: draculaTheme.colors.gitDeleted,
    gitModified: draculaTheme.colors.gitModified,
    gitUntracked: draculaTheme.colors.gitUntracked,
    merged: draculaTheme.colors.merged,
    muted: draculaTheme.colors.muted,
    primary: draculaTheme.colors.accent,
    primaryForeground: draculaTheme.colors.background,
    success: draculaTheme.colors.success,
    surface: draculaTheme.colors.surface,
    text: draculaTheme.colors.foreground,
    warning: draculaTheme.colors.warning,
} as const satisfies MobileTheme;
