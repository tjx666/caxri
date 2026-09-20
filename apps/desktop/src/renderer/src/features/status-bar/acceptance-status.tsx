import type { ProjectStatusOverviewAcceptance, ProjectStatusState } from '@caxri/protocol';
import {
    CircleCheck,
    CircleDashed,
    CircleDot,
    CircleSlash,
    CircleSmall,
    CircleX,
    LoaderCircle,
} from 'lucide-react';

import {
    acceptanceAriaLabel,
    acceptanceChipLabel,
    acceptanceTooltipLines,
} from './acceptance-label';
import { StatusInfo } from './status-info';
import { StatusItem } from './status-item';

/**
 * Shape says where the report stands, color says whether that is good news. The Server already reduced the lifecycle
 * and the round result to `state`, so this is presentation only — the Status panel draws the same state with its own
 * codicons and reaches the same conclusion by construction. `unknown` is the link Caxri recognized but never read, and
 * deliberately looks inert rather than alarming.
 */
const STATE_PRESENTATION: Record<ProjectStatusState, { Icon: typeof CircleCheck; tone: string }> = {
    success: { Icon: CircleCheck, tone: 'text-success' },
    failure: { Icon: CircleX, tone: 'text-danger' },
    pending: { Icon: LoaderCircle, tone: 'text-warning' },
    // A filled dot rather than a spinner: nothing is running yet, and animating a queue makes it look like it is.
    queued: { Icon: CircleSmall, tone: 'fill-current text-warning' },
    cancelled: { Icon: CircleSlash, tone: 'text-muted' },
    neutral: { Icon: CircleDashed, tone: 'text-muted' },
    unknown: { Icon: CircleDot, tone: 'text-muted' },
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
        title: (
            <span className="whitespace-pre-wrap">
                {acceptanceTooltipLines(acceptance, extra).join('\n')}
            </span>
        ),
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
