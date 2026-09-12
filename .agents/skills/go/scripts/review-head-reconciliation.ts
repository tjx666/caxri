import { MAX_NOTE_TEXT_CHARACTERS, sanitizeLedgerDetail } from './note-safety';
import {
    applyLatestReviewHeadReconciliation,
    planLatestReviewHeadReconciliation,
} from './review-gate';
import type { GoState } from './state-model';
import { addEvent } from './state-model';
import type { WorktreeIntegrity } from './worktree-integrity';
import {
    assertGitAncestor,
    assertGitCommitMissing,
    inspectWorktreeIntegrity,
    resolveGitCommit,
} from './worktree-integrity';

interface ReviewHeadValidation {
    canonicalHeadSha: string;
    integrity: WorktreeIntegrity;
}

export async function assertReviewHeadMatchesWorktree(
    state: GoState,
    requestedHeadSha: string,
): Promise<ReviewHeadValidation> {
    if (!state.worktree) throw new Error('Review requires a recorded worktree');
    if (state.mutationLease) throw new Error('Review requires no active mutation lease');
    const integrity = await inspectWorktreeIntegrity(state.worktree.path);
    if (!integrity.clean) throw new Error('Review requires a clean recorded worktree');
    const canonicalHeadSha = await resolveGitCommit(state.worktree.path, requestedHeadSha);
    if (requestedHeadSha !== canonicalHeadSha || canonicalHeadSha !== integrity.headSha) {
        throw new Error('Review head must be the canonical current worktree HEAD');
    }
    return { canonicalHeadSha, integrity };
}

export async function assertReviewHeadUnchangedBeforeWrite(
    state: GoState,
    validation: ReviewHeadValidation,
): Promise<void> {
    if (!state.worktree) throw new Error('Review requires a recorded worktree');
    const current = await inspectWorktreeIntegrity(state.worktree.path);
    if (
        !current.clean ||
        current.headSha !== validation.integrity.headSha ||
        current.sourceFingerprint !== validation.integrity.sourceFingerprint
    ) {
        throw new Error('Git-visible worktree identity changed before review could be persisted');
    }
}

/**
 * Resolves the correction from committed Git history instead of accepting replacement input. Dirty tooling is allowed
 * because it is outside the amended review's committed delta; matching integrity reads still prevent the Git-visible
 * worktree identity from changing while the audit and correction are prepared.
 */
export async function reconcileLatestReviewHeadFromWorktree(
    state: GoState,
    input: { reason: string; reviewId: string },
): Promise<void> {
    if (!state.worktree) {
        throw new Error('Review head reconciliation requires a recorded worktree');
    }
    const latest = state.reviewGate.rounds.at(-1);
    const parent = state.reviewGate.rounds.at(-2);
    if (!latest || !parent) {
        throw new Error('Review head reconciliation requires a nonbaseline review');
    }
    const before = await inspectWorktreeIntegrity(state.worktree.path);
    const actualHeadSha = await resolveGitCommit(state.worktree.path, 'HEAD');
    if (actualHeadSha !== before.headSha) {
        throw new Error('Resolved worktree HEAD changed during review reconciliation');
    }
    const canonicalParent = await resolveGitCommit(state.worktree.path, parent.headSha);
    if (canonicalParent !== parent.headSha) {
        throw new Error('Review parent must be a canonical Git commit');
    }
    await assertGitCommitMissing(state.worktree.path, latest.headSha);
    await assertGitAncestor(state.worktree.path, canonicalParent, actualHeadSha);
    const reconciliation = planLatestReviewHeadReconciliation(state, {
        actualHeadSha,
        reason: input.reason,
        reviewId: input.reviewId,
    });
    const auditDetail = JSON.stringify({
        actualHeadSha,
        correctedRange: reconciliation.correctedRange,
        original: reconciliation.original,
        reason: input.reason.trim(),
    });
    if (
        auditDetail.length > MAX_NOTE_TEXT_CHARACTERS ||
        sanitizeLedgerDetail(auditDetail) !== auditDetail
    ) {
        throw new Error(
            'Review head reconciliation audit cannot be stored losslessly in the event ledger',
        );
    }
    const after = await inspectWorktreeIntegrity(state.worktree.path);
    if (
        before.headSha !== after.headSha ||
        before.sourceFingerprint !== after.sourceFingerprint ||
        before.clean !== after.clean
    ) {
        throw new Error('Git-visible worktree identity changed during review reconciliation');
    }
    applyLatestReviewHeadReconciliation(state, reconciliation);
    addEvent(state, 'review_head_reconciliation', auditDetail);
}
