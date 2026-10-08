import type {
    AcceptanceSource,
    AcceptanceStatus,
    AcceptanceVerdict,
    ProjectStatusAcceptance,
    ProjectStatusOverviewAcceptance,
} from '@caxri/protocol';

import type { StructuredTooltipData } from '../../components/structured-tooltip';

/**
 * How the chip names each source, in the wording a reader needs to decide how much to trust it: a pull request states
 * the link on purpose, a conversation is something an Agent happened to mention.
 */
const SOURCE_LABELS: Record<AcceptanceSource, string> = {
    'pull-request': 'From the pull request description',
    'conversation': 'From this conversation',
};

/**
 * Lifecycle wording, spelled out rather than title-cased from the enum. `delivered` and `accepted` differ by who acted
 * (the Agent finished, a person agreed) and that distinction is the whole reason a reviewer looks at this chip.
 *
 * Kept byte-identical to `acceptanceStatusLabels` in `extensions/status/src/status-labels.ts`, together with
 * {@link VERDICT_LABELS} and its counterpart there. The two cannot share a module: the architecture boundary forbids
 * Desktop importing `extension-api`, and `extension-api` imports nothing, so the copies are the contract: change one
 * and the Status panel row and this chip name the same report two different things, with nothing failing.
 */
const STATUS_LABELS: Record<AcceptanceStatus, string> = {
    pending: 'Not started',
    planned: 'Plan ready',
    verifying: 'Verifying',
    repairing: 'Repairing',
    delivered: 'Awaiting review',
    accepted: 'Accepted',
    closed: 'Closed',
    rejected: 'Rejected',
    errored: 'Errored',
};

const VERDICT_LABELS: Record<AcceptanceVerdict, string> = {
    passed: 'Checks passed',
    failed: 'Checks failed',
    uncertain: 'Checks inconclusive',
};

/**
 * The densest true statement the chip can make, in order of preference: the check tally, then the lifecycle word, then
 * the reason there is neither.
 *
 * `Unknown` comes first because it is the only case where the chip has to admit something. `state: 'unknown'` means the
 * report's lookup failed, so no number and no lifecycle word exist, and the old fallback, the bare noun `Acceptance`,
 * said nothing the shield beside it had not already said while looking like a report that was simply quiet.
 *
 * The id is deliberately never shown. It is an opaque UUID that tells a reader nothing, and it names a private
 * acceptance record: the identifier that earns the Linear chip its place has no counterpart here.
 */
export function acceptanceChipLabel(acceptance: ProjectStatusAcceptance): string {
    if (acceptance.state === 'unknown') return 'Unknown';
    if (acceptance.totalChecks !== undefined && acceptance.passedChecks !== undefined)
        return `${acceptance.passedChecks}/${acceptance.totalChecks}`;
    if (acceptance.status) return STATUS_LABELS[acceptance.status];
    return 'Acceptance';
}

/**
 * The chip's accessible name. The label alone is a bare tally, so everything the glyph and its tint carry (lifecycle
 * and verdict) plus the subject and the provenance have to be spoken here instead.
 */
export function acceptanceAriaLabel(
    acceptance: ProjectStatusOverviewAcceptance,
    extraCount = 0,
): string {
    return [
        acceptance.url ? 'Open acceptance report' : 'Acceptance report',
        acceptance.title,
        acceptance.round === undefined ? undefined : `Round ${acceptance.round}`,
        acceptance.status && STATUS_LABELS[acceptance.status],
        acceptance.verdict && VERDICT_LABELS[acceptance.verdict],
        acceptance.totalChecks === undefined || acceptance.passedChecks === undefined
            ? undefined
            : `${acceptance.passedChecks} of ${acceptance.totalChecks} checks passed`,
        SOURCE_LABELS[acceptance.source],
        extraCount > 0
            ? `${extraCount} more ${extraCount === 1 ? 'report' : 'reports'}`
            : undefined,
    ]
        .filter(Boolean)
        .join(', ');
}

/**
 * The hover tooltip's content. Kept as data rather than JSX so the wording stays unit-testable; `StructuredTooltip`
 * decides the hierarchy.
 */
export function acceptanceTooltip(
    acceptance: ProjectStatusOverviewAcceptance,
    extra: readonly ProjectStatusOverviewAcceptance[] = [],
): StructuredTooltipData {
    const round =
        acceptance.round === undefined
            ? // No pinned round means the link addressed the report as a whole, so the latest one answered it: worth
              // saying, because the same chip would otherwise look identical to a link that pinned that round.
              acceptance.roundCount === undefined || acceptance.roundCount <= 1
                ? undefined
                : `Latest of ${acceptance.roundCount} rounds`
            : `Round ${acceptance.round}`;
    const details = [
        [acceptance.status && STATUS_LABELS[acceptance.status], round]
            .filter(Boolean)
            .join(' · ') || undefined,
        acceptance.verdict && VERDICT_LABELS[acceptance.verdict],
    ].filter((line): line is string => Boolean(line));
    const notes = [
        SOURCE_LABELS[acceptance.source],
        extra.length > 0
            ? `Also referenced: ${extra.length} more ${extra.length === 1 ? 'report' : 'reports'}`
            : undefined,
    ].filter((line): line is string => Boolean(line));
    return {
        eyebrow: acceptance.title ? 'Acceptance report' : undefined,
        title: acceptance.title ?? 'Acceptance report',
        details,
        notes,
        hint: acceptance.url ? 'Click to open the report' : undefined,
    };
}
