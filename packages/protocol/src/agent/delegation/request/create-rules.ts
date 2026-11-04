/**
 * The fields the cross-field rules of a delegation request read. Shared by the stored and the request schema so both
 * enforce one rule set.
 */
export type DelegationCreateShape = Partial<
    Record<
        | 'continueFromHandover'
        | 'effort'
        | 'followUpOf'
        | 'model'
        | 'preset'
        | 'provider'
        | 'resumeFrom'
        | 'surface',
        unknown
    >
>;

export const isOneContinuation = (value: DelegationCreateShape) =>
    [value.followUpOf, value.resumeFrom, value.continueFromHandover].filter(Boolean).length <= 1;
export const isPresetExclusive = (value: DelegationCreateShape) =>
    !value.preset || (!value.provider && !value.model && !value.effort);
export const isSurfaceForNewTask = (value: DelegationCreateShape) =>
    !value.surface || (!value.followUpOf && !value.resumeFrom && !value.continueFromHandover);
export const hasLaunchSource = (value: DelegationCreateShape) =>
    Boolean(
        value.provider ??
        value.preset ??
        value.followUpOf ??
        value.resumeFrom ??
        value.continueFromHandover,
    );
/**
 * A hand-over continues an existing conversation, whose provider and launch are already fixed.
 */
export const isHandoverSelectionFree = (value: DelegationCreateShape) =>
    !value.continueFromHandover ||
    (!value.provider && !value.preset && !value.model && !value.effort);
