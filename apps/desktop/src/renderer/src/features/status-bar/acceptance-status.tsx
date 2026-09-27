import type { ProjectStatusOverviewAcceptance, ProjectStatusState } from '@caxri/protocol';
import {
    Shield,
    ShieldAlert,
    ShieldCheck,
    ShieldEllipsis,
    ShieldMinus,
    ShieldX,
} from 'lucide-react';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { acceptanceAriaLabel, acceptanceChipLabel, acceptanceTooltip } from './acceptance-label';
import { StatusInfo } from './status-info';
import { StatusItem } from './status-item';

/**
 * The shield says this chip is an acceptance report rather than one more circle among the CI, Linear, and deployment
 * chips beside it; the interior symbol says where the report stands, and colour says whether that is good news. The
 * Status panel's acceptance rows use the same family for the same reason (`acceptanceIcon` in the Status extension), so
 * the chip and the row name one report the same way. `unknown` is the link Caxri recognized but never read, and
 * deliberately looks inert rather than alarming.
 */
const STATE_PRESENTATION: Record<ProjectStatusState, { Icon: typeof Shield; tone: string }> = {
    success: { Icon: ShieldCheck, tone: 'text-success' },
    failure: { Icon: ShieldX, tone: 'text-danger' },
    pending: { Icon: ShieldEllipsis, tone: 'text-warning' },
    // Accepted for verification and not started: the shield is there, it just has nothing to report yet.
    queued: { Icon: Shield, tone: 'text-warning' },
    cancelled: { Icon: ShieldMinus, tone: 'text-muted' },
    neutral: { Icon: ShieldMinus, tone: 'text-muted' },
    unknown: { Icon: ShieldAlert, tone: 'text-danger' },
};

/**
 * The branch's acceptance report, as a tally rather than a name.
 *
 * The Linear chip leads with its identifier because `ABC-123` is what a person says out loud. An acceptance has no such
 * handle — only an opaque id — so the chip spends its width on the thing a reviewer actually wants at a glance: how
 * many checks passed, in the color of the current verdict. The subject, the round, and the provenance stay on the hover
 * card.
 */
export function AcceptanceStatus({
    acceptances,
}: {
    acceptances: readonly ProjectStatusOverviewAcceptance[];
}) {
    if (acceptances.length === 0) return null;
    const [acceptance, ...extra] = acceptances;
    const { Icon, tone } = STATE_PRESENTATION[acceptance.state];
    const shared = {
        ariaLabel: acceptanceAriaLabel(acceptance, extra.length),
        icon: <Icon className={tone} />,
        title: <StructuredTooltip {...acceptanceTooltip(acceptance, extra)} />,
    };
    const label = (
        <>
            {acceptanceChipLabel(acceptance)}
            {extra.length > 0 && <span className="ml-1 text-muted">+{extra.length}</span>}
        </>
    );
    // A link we recognized but could not read has no destination, so it must not look clickable — the same reading
    // `LinearIssueStatus` applies. `focusable` keeps it reachable by keyboard, the only way a non-mouse user reaches
    // the hover card's source line.
    return acceptance.url ? (
        <StatusItem {...shared} className="statusbar-acceptance" href={acceptance.url}>
            {label}
        </StatusItem>
    ) : (
        <StatusInfo {...shared} className="statusbar-acceptance text-muted" focusable>
            {label}
        </StatusInfo>
    );
}
