import { useTranslation } from '../../i18n';

/**
 * The `Show N more` row that closes a windowed Session list, shared by Project groups, the Pinned group, and the
 * Activity view's windowed status groups.
 *
 * The button is the row: it holds the roving Tab stop, so it carries the tree semantics itself instead of sitting
 * inside a `treeitem` wrapper focus never reaches. It is deliberately content-width rather than `w-full`: a full-width
 * hover background read as a selected Session row, so its hover and focus ring stay on the label (the Codex app's
 * compact fold, issue #2585). The left margin puts the label on the Session title's left edge, past the row's 8px
 * inset, its 14px Agent glyph, and the 8px gap. No disclosure chevron: this is not a collapsible branch, and a twistie
 * would spend width on a meaning the row does not have.
 */
export function SessionRevealRow({
    ariaLabel: ariaLabelOverride,
    count = 0,
    direction = 'more',
    level = 2,
    projectTitle,
    roving,
    rowId,
    onReveal,
}: {
    /**
     * Replaces the Project/Pinned accessible name, for a list whose group is neither (the Activity view's status
     * groups, a host's nested Sessions).
     */
    ariaLabel?: string;
    /**
     * How many Sessions this activation reveals; the visible label (`Show N more`) and the accessible name both carry
     * it.
     */
    count?: number;
    /**
     * `more` (default) is the `Show N more` row that closes a windowed list; `fewer` is the `Show fewer` row that folds
     * a revealed list back to its default rows. It sits after those default rows rather than at the list end, where the
     * pointer already is after a reveal (the lesson the subagent toggle learned: a trailing fold below a long list was
     * never reached).
     */
    direction?: 'fewer' | 'more';
    /**
     * The row's `aria-level`: 2 under a group heading, 3 under a Session row (a host's nested Sessions).
     */
    level?: 2 | 3;
    /**
     * The Project group's title, named in the accessible name; omitted for the Pinned group.
     */
    projectTitle?: string;
    roving: boolean;
    rowId: string;
    onReveal: () => void;
}) {
    const { t } = useTranslation();
    const isFewer = direction === 'fewer';
    const ariaLabel =
        ariaLabelOverride ??
        (isFewer
            ? projectTitle === undefined
                ? t('primarySidebar.pinned.showFewerAriaLabel')
                : t('primarySidebar.project.showFewerAriaLabel', { title: projectTitle })
            : projectTitle === undefined
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
                ));
    return (
        <button
            className="session-reveal mt-0.5 ml-5.5 flex h-6 w-fit max-w-[calc(100%-22px)] cursor-pointer items-center overflow-hidden rounded-md border-0 bg-transparent px-2 text-xs whitespace-nowrap text-muted hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
            role="treeitem"
            aria-label={ariaLabel}
            aria-level={level}
            aria-selected={false}
            data-row-id={rowId}
            tabIndex={roving ? 0 : -1}
            onClick={onReveal}
        >
            <span className="truncate">
                {isFewer
                    ? t('primarySidebar.reveal.showFewer')
                    : t('primarySidebar.reveal.showMore', { count })}
            </span>
        </button>
    );
}
