/**
 * Unsent answers to delegated questions, by delegation ID. The question card unmounts when the user switches Sessions
 * or the strip re-renders around it, and a half-typed answer must survive that. Module-level on purpose: the draft is
 * short-lived UI state, not persisted, and clears once the answer is sent.
 */
const drafts = new Map<string, string>();

export function getDelegationAnswerDraft(delegationId: string): string {
    return drafts.get(delegationId) ?? '';
}

export function setDelegationAnswerDraft(delegationId: string, draft: string): void {
    if (draft === '') drafts.delete(delegationId);
    else drafts.set(delegationId, draft);
}

export function clearDelegationAnswerDraft(delegationId: string): void {
    drafts.delete(delegationId);
}
