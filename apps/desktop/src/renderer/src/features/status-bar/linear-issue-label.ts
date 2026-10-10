import type { LinearIssueSource, ProjectStatusOverviewLinearIssue } from '@caxri/protocol';

import type { StructuredTooltipData } from '../../components/structured-tooltip';

/**
 * How the chip names each source. The wording is the sentence a reader needs in order to decide how much to trust the
 * chip; a pull request states the link on purpose, a branch name is a convention, and a conversation is an inference.
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
 * carry (the workflow state) plus the title and the provenance have to be spoken here instead.
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
 * Whether the hover card lists another issue it can open, which needs a card the pointer can enter.
 */
export function hasOpenableLinearIssue(
    extra: readonly ProjectStatusOverviewLinearIssue[],
): boolean {
    return extra.some((other) => other.url);
}

/**
 * The hover tooltip's content. Kept as data rather than JSX so the wording stays unit-testable; `StructuredTooltip`
 * decides the hierarchy.
 */
export function linearIssueTooltip(
    issue: ProjectStatusOverviewLinearIssue,
    extra: readonly ProjectStatusOverviewLinearIssue[] = [],
): StructuredTooltipData {
    return {
        eyebrow: issue.title ? issue.identifier : undefined,
        title: issue.title ?? issue.identifier,
        details: issue.state ? [issue.state] : [],
        notes: [linearIssueSourceLabel(issue.source)],
        links:
            extra.length > 0
                ? {
                      label: 'Also referenced',
                      // A bare identifier says nothing about which issue it is; the title does when it resolved.
                      items: extra.map((other) => ({
                          label: other.title
                              ? `${other.identifier}: ${other.title}`
                              : other.identifier,
                          href: other.url,
                      })),
                  }
                : undefined,
        // With other issues listed, "open in Linear" alone no longer says which one the chip itself opens.
        hint: issue.url
            ? extra.length > 0
                ? `Click to open ${issue.identifier} in Linear`
                : 'Click to open in Linear'
            : undefined,
    };
}
