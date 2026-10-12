import type { ProjectStatusOverviewLinearIssue } from '@caxri/protocol';

import { StructuredTooltip } from '../../components/structured-tooltip';
import { useTranslation } from '../../i18n';
import { LinearStatusIcon } from '../../icons/linear/linear-status-icon';
import {
    hasOpenableLinearIssue,
    linearIssueAriaLabel,
    linearIssueTooltip,
} from './linear-issue-label';
import { StatusInfo } from './status-info';
import { StatusItem } from './status-item';

/**
 * The chip prints the identifier and nothing else. A Linear title is a sentence, and the status bar's left group
 * already competes with the root, the branch, and the pull request for one line, so the workflow state arrives as the
 * glyph (`stateType`) in the workspace's own color (`stateColor`), the same pairing the Status panel uses, and the
 * title stays on the hover card.
 */
export function LinearIssueStatus({
    issues,
}: {
    issues: readonly ProjectStatusOverviewLinearIssue[];
}) {
    const { t } = useTranslation();
    if (issues.length === 0) return null;
    const [issue, ...extra] = issues;
    const shared = {
        ariaLabel: linearIssueAriaLabel(issue, extra.length, t),
        icon: (
            <LinearStatusIcon
                kind={issue.stateType ?? 'backlog'}
                style={issue.stateColor ? { color: issue.stateColor } : undefined}
            />
        ),
        // The other referenced issues are links on the card, so it must stay open under the pointer.
        interactiveTitle: hasOpenableLinearIssue(extra),
        title: <StructuredTooltip {...linearIssueTooltip(issue, extra, t)} />,
    };
    const label = (
        <>
            {issue.identifier}
            {extra.length > 0 && <span className="ml-1 text-muted">+{extra.length}</span>}
        </>
    );
    // An identifier we recognized but could not resolve has no destination, so it must not look clickable. `StatusInfo`
    // is exactly that reading, and `focusable` keeps it reachable by keyboard: the only way a non-mouse user can read
    // the source line in the hover card.
    return issue.url ? (
        <StatusItem {...shared} className="statusbar-linear-issue" href={issue.url}>
            {label}
        </StatusItem>
    ) : (
        <StatusInfo {...shared} className="statusbar-linear-issue text-muted" focusable>
            {label}
        </StatusInfo>
    );
}
