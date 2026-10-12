import type {
    AcceptanceSource,
    AcceptanceStatus,
    AcceptanceVerdict,
    ProjectStatusAcceptance,
    ProjectStatusOverviewAcceptance,
} from '@caxri/protocol';

import type { StructuredTooltipData } from '../../components/structured-tooltip';
import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

/**
 * How the chip names each source, in the wording a reader needs to decide how much to trust it: a pull request states
 * the link on purpose, a conversation is something an Agent happened to mention.
 */
const SOURCE_LABEL_KEYS: Record<AcceptanceSource, TranslationKey> = {
    'pull-request': 'statusBar.source.pullRequest',
    'conversation': 'statusBar.source.conversation',
};

/**
 * Lifecycle wording, spelled out rather than title-cased from the enum. `delivered` and `accepted` differ by who acted
 * (the Agent finished, a person agreed) and that distinction is the whole reason a reviewer looks at this chip.
 *
 * The English strings (`statusBar.acceptance.status.*` in the `statusBar` locale module) are kept byte-identical to
 * `acceptanceStatusLabels` in `extensions/status/src/status-labels.ts`, together with the `verdict.*` strings and their
 * counterpart there. The two cannot share a module: the architecture boundary forbids Desktop importing
 * `extension-api`, and `extension-api` imports nothing, so the copies are the contract: change one and the Status panel
 * row and this chip name the same report two different things, with nothing failing.
 */
function statusLabel(status: AcceptanceStatus, t: Translate): string {
    return t(`statusBar.acceptance.status.${status}`);
}

/**
 * See {@link statusLabel}: the English text mirrors the Status extension's verdict labels.
 */
function verdictLabel(verdict: AcceptanceVerdict, t: Translate): string {
    return t(`statusBar.acceptance.verdict.${verdict}`);
}

function moreReports(count: number, t: Translate): string {
    return t(
        count === 1
            ? 'statusBar.acceptance.moreReportsOne'
            : 'statusBar.acceptance.moreReportsOther',
        { count },
    );
}

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
export function acceptanceChipLabel(
    acceptance: ProjectStatusAcceptance,
    t: Translate = translate,
): string {
    if (acceptance.state === 'unknown') return t('common.unknown');
    if (acceptance.totalChecks !== undefined && acceptance.passedChecks !== undefined)
        return `${acceptance.passedChecks}/${acceptance.totalChecks}`;
    if (acceptance.status) return statusLabel(acceptance.status, t);
    return t('statusBar.acceptance.noun');
}

/**
 * The chip's accessible name. The label alone is a bare tally, so everything the glyph and its tint carry (lifecycle
 * and verdict) plus the subject and the provenance have to be spoken here instead.
 */
export function acceptanceAriaLabel(
    acceptance: ProjectStatusOverviewAcceptance,
    extraCount = 0,
    t: Translate = translate,
): string {
    return [
        t(acceptance.url ? 'statusBar.acceptance.openReport' : 'statusBar.acceptance.report'),
        acceptance.title,
        acceptance.round === undefined
            ? undefined
            : t('statusBar.acceptance.round', { round: acceptance.round }),
        acceptance.status && statusLabel(acceptance.status, t),
        acceptance.verdict && verdictLabel(acceptance.verdict, t),
        acceptance.totalChecks === undefined || acceptance.passedChecks === undefined
            ? undefined
            : t('statusBar.acceptance.checksPassed', {
                  passed: acceptance.passedChecks,
                  total: acceptance.totalChecks,
              }),
        t(SOURCE_LABEL_KEYS[acceptance.source]),
        extraCount > 0 ? moreReports(extraCount, t) : undefined,
    ]
        .filter(Boolean)
        .join(t('statusBar.listSeparator'));
}

/**
 * The hover tooltip's content. Kept as data rather than JSX so the wording stays unit-testable; `StructuredTooltip`
 * decides the hierarchy.
 */
export function acceptanceTooltip(
    acceptance: ProjectStatusOverviewAcceptance,
    extra: readonly ProjectStatusOverviewAcceptance[] = [],
    t: Translate = translate,
): StructuredTooltipData {
    const round =
        acceptance.round === undefined
            ? // No pinned round means the link addressed the report as a whole, so the latest one answered it: worth
              // saying, because the same chip would otherwise look identical to a link that pinned that round.
              acceptance.roundCount === undefined || acceptance.roundCount <= 1
                ? undefined
                : t('statusBar.acceptance.latestOfRounds', { count: acceptance.roundCount })
            : t('statusBar.acceptance.round', { round: acceptance.round });
    const details = [
        [acceptance.status && statusLabel(acceptance.status, t), round]
            .filter(Boolean)
            .join(' · ') || undefined,
        acceptance.verdict && verdictLabel(acceptance.verdict, t),
    ].filter((line): line is string => Boolean(line));
    const notes = [
        t(SOURCE_LABEL_KEYS[acceptance.source]),
        extra.length > 0
            ? t('statusBar.acceptance.alsoReferenced', { more: moreReports(extra.length, t) })
            : undefined,
    ].filter((line): line is string => Boolean(line));
    return {
        eyebrow: acceptance.title ? t('statusBar.acceptance.report') : undefined,
        title: acceptance.title ?? t('statusBar.acceptance.report'),
        details,
        notes,
        hint: acceptance.url ? t('statusBar.acceptance.hint') : undefined,
    };
}
