import { z } from 'zod';

export const mutationLeaseKindSchema = z.enum(['repair', 'validation']);
export const mutationLeaseSchema = z
    .object({
        acquiredAt: z.string(),
        holderId: z.string().min(1),
        kind: mutationLeaseKindSchema,
    })
    .nullable();

export type MutationLease = z.infer<typeof mutationLeaseSchema>;
type MutationLeaseKind = z.infer<typeof mutationLeaseKindSchema>;

interface MutationLeaseContext {
    mutationLease: MutationLease;
}

export function acquireMutationLease(
    state: MutationLeaseContext,
    input: { holderId: string; kind: MutationLeaseKind },
    acquiredAt = new Date().toISOString(),
): NonNullable<MutationLease> {
    if (state.mutationLease) {
        if (
            state.mutationLease.holderId === input.holderId &&
            state.mutationLease.kind === input.kind
        ) {
            return state.mutationLease;
        }
        throw new Error(
            `Worktree mutation lease is held by ${state.mutationLease.kind}:${state.mutationLease.holderId}`,
        );
    }
    const lease = mutationLeaseSchema.unwrap().parse({ ...input, acquiredAt });
    state.mutationLease = lease;
    return lease;
}

export function releaseMutationLease(
    state: MutationLeaseContext,
    input: { holderId: string; kind: MutationLeaseKind },
): void {
    if (!state.mutationLease) throw new Error('No worktree mutation lease is active');
    if (
        state.mutationLease.holderId !== input.holderId ||
        state.mutationLease.kind !== input.kind
    ) {
        throw new Error(
            `Worktree mutation lease belongs to ${state.mutationLease.kind}:${state.mutationLease.holderId}`,
        );
    }
    state.mutationLease = null;
}
