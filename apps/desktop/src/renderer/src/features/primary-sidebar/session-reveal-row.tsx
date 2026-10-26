import { useTranslation } from '../../i18n';

/**
 * The `Show more` row that closes a windowed Session list, shared by Project groups and the Pinned group.
 *
 * The button is the row: it holds the roving Tab stop, so it carries the tree semantics itself instead of sitting
 * inside a `treeitem` wrapper focus never reaches. It is deliberately content-width rather than `w-full`: a full-width
 * hover background read as a selected Session row, so its hover and focus ring stay on the label (the Codex app's
 * compact fold, issue #2585). The left margin puts the label on the Session title's left edge, past the row's 8px
 * inset, its 14px Agent glyph, and the 8px gap. No disclosure chevron: this is not a collapsible branch, and a twistie
 * would spend width on a meaning the row does not have.
 */
export function SessionRevealRow({
    count,
    projectTitle,
    roving,
    rowId,
    onReveal,
}: {
    /**
     * How many Sessions this activation reveals; only the accessible name carries it, not the visible label.
     */
    count: number;
    /**
     * The Project group's title, named in the accessible name; omitted for the Pinned group.
     */
    projectTitle?: string;
    roving: boolean;
    rowId: string;
    onReveal: () => void;
}) {
    const { t } = useTranslation();
    const ariaLabel =
        projectTitle === undefined
            ? t(
                  count === 1
                      ? 'primarySidebar.pinned.revealAriaLabelOne'
                      : 'primarySidebar.pinned.revealAriaLabelOther',
                  { count },
              )
            : t(
                  count === 1
                      ? 'primarySidebar.project.revealAriaLabelOne'
                      : 'primarySidebar.project.revealAriaLabelOther',
                  { count, title: projectTitle },
              );
    return (
        <button
            className="session-reveal mt-0.5 ml-5.5 flex h-6 w-fit max-w-[calc(100%-22px)] cursor-pointer items-center overflow-hidden rounded-md border-0 bg-transparent px-2 text-xs whitespace-nowrap text-muted hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
            role="treeitem"
            aria-label={ariaLabel}
            aria-level={2}
            aria-selected={false}
            data-row-id={rowId}
            tabIndex={roving ? 0 : -1}
            onClick={onReveal}
        >
            <span className="truncate">{t('primarySidebar.reveal.showMore')}</span>
        </button>
    );
}
