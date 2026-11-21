/**
 * The weight and color of a Session row's title. A nested row (a Session under its host, issue #4092) steps down to
 * regular weight and muted text so the hierarchy reads from the rows themselves, not only from the branch guide. It
 * returns to full contrast when the pointer, the selection, or a cue that needs the user (a pending approval, a failed
 * delegation) lands on it.
 */
export function sessionTitleToneClassName({
    approvalPending = false,
    delegationFailed = false,
    nested = false,
    selected,
}: {
    approvalPending?: boolean;
    delegationFailed?: boolean;
    nested?: boolean;
    selected: boolean;
}): string {
    if (!nested) return 'font-medium';
    if (selected || approvalPending || delegationFailed) return 'font-normal text-foreground';
    return 'font-normal text-muted group-hover/session-row:text-foreground';
}
