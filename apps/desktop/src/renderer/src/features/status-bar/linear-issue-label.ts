import type { LinearIssueSource, ProjectStatusOverviewLinearIssue } from '@caxri/protocol';

import type { StructuredTooltipData } from '../../components/structured-tooltip';
import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

/**
 * How the chip names each source. The wording is the sentence a reader needs in order to decide how much to trust the
 * chip; a pull request states the link on purpose, a branch name is a convention, and a conversation is an inference.
 */
const SOURCE_LABEL_KEYS: Record<LinearIssueSource, TranslationKey> = {
    'pull-request': 'statusBar.source.pullRequest',
    'branch': 'statusBar.source.branch',
    'conversation': 'statusBar.source.conversation',
};

/**
 * The chip's accessible name. The identifier alone is what a sighted user sees, so everything the glyph and its tint
 * carry (the workflow state) plus the title and the provenance have to be spoken here instead.
 */
export function linearIssueAriaLabel(
    issue: ProjectStatusOverviewLinearIssue,
    extraCount = 0,
    t: Translate = translate,
): string {
    const identifier = { identifier: issue.identifier };
    return [
        t(issue.url ? 'statusBar.linear.openIssue' : 'statusBar.linear.issue', identifier),
        issue.title,
        issue.state,
        t(SOURCE_LABEL_KEYS[issue.source]),
        extraCount > 0
            ? t(
                  extraCount === 1
                      ? 'statusBar.linear.moreIssuesOne'
                      : 'statusBar.linear.moreIssuesOther',
                  { count: extraCount },
              )
            : undefined,
    ]
        .filter(Boolean)
        .join(t('statusBar.listSeparator'));
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
    t: Translate = translate,
): StructuredTooltipData {
    return {
        eyebrow: issue.title ? issue.identifier : undefined,
        title: issue.title ?? issue.identifier,
        details: issue.state ? [issue.state] : [],
        notes: [t(SOURCE_LABEL_KEYS[issue.source])],
        links:
            extra.length > 0
                ? {
                      label: t('statusBar.alsoReferenced'),
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
                ? t('statusBar.linear.clickToOpenIdentifier', { identifier: issue.identifier })
                : t('statusBar.linear.clickToOpen')
            : undefined,
    };
}
