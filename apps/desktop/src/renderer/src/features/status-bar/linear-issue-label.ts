import type { LinearIssueSource, ProjectStatusOverviewLinearIssue } from '@caxri/protocol';

/**
 * How the chip names each source. The wording is the sentence a reader needs in order to decide how much to trust the
 * chip — a pull request states the link on purpose, a branch name is a convention, and a conversation is an inference.
 */
const SOURCE_LABELS: Record<LinearIssueSource, string> = {
    'pull-request': 'From the pull request description',
    'branch': 'From the branch name',
    'conversation': 'From this conversation',
};

function linearIssueSourceLabel(source: LinearIssueSource): string {
    return SOURCE_LABELS[source];
}

/**
 * The chip's accessible name. The identifier alone is what a sighted user sees, so everything the glyph and its tint
 * carry — the workflow state — plus the title and the provenance have to be spoken here instead.
 */
export function linearIssueAriaLabel(
    issue: ProjectStatusOverviewLinearIssue,
    extraCount = 0,
): string {
    return [
        issue.url ? `Open Linear issue ${issue.identifier}` : `Linear issue ${issue.identifier}`,
        issue.title,
        issue.state,
        linearIssueSourceLabel(issue.source),
        extraCount > 0 ? `${extraCount} more ${extraCount === 1 ? 'issue' : 'issues'}` : undefined,
    ]
        .filter(Boolean)
        .join(', ');
}

/**
 * The hover card's lines, in reading order. Kept as data rather than JSX so the wording stays unit-testable; the
 * component only decides how to stack them.
 */
export function linearIssueTooltipLines(
    issue: ProjectStatusOverviewLinearIssue,
    extra: readonly ProjectStatusOverviewLinearIssue[] = [],
): string[] {
    return [
        [issue.identifier, issue.title].filter(Boolean).join(' '),
        issue.state,
        linearIssueSourceLabel(issue.source),
        extra.length > 0
            ? `Also referenced: ${extra.map((other) => other.identifier).join(', ')}`
            : undefined,
    ].filter((line): line is string => Boolean(line));
}
