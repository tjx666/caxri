import { AlertTriangle, X } from 'lucide-react';

import type { ContainerBadge } from './view-badges';

/**
 * The container tab's aggregated badge.
 *
 * A badge draws a glyph or a tally, never both, and severity always wins the chip. That is VS Code's own composite-bar
 * rule: `getVisibleBadges()` in `compositeBarActions.ts` is a strict ladder over mutually exclusive `progress`, `icon`,
 * and `number` badges, and its `ErrorBadge`/`WarningBadge` have no number to show in the first place. Letting a tally
 * win instead left severity riding on the fill alone, so the Status tab's `5` and the Git tab's `5` were the same size,
 * shape, and position and differed only by color, indistinguishable to a colorblind user and in any greyscale capture.
 * {@link ContainerBadge} now makes that state unrepresentable rather than guarding it here.
 *
 * The glyph is the Workbench's, never the extension's: a badge reports meaning and the Workbench owns how meaning
 * looks. The tally the glyph displaced is not dropped; it stays in the joined `description` the tab publishes as its
 * tooltip and its accessible description, which is one thing Caxri does not copy from VS Code (`computeTitle()` there
 * drops the number from the label too).
 */
export function ContainerBadgeChip({
    badge,
    containerId,
}: {
    badge: ContainerBadge;
    containerId: string;
}) {
    const fill = {
        count: 'bg-badge text-badge-foreground',
        error: 'bg-error-badge text-error-badge-foreground',
        warning: 'bg-warning-badge text-warning-badge-foreground',
    }[badge.kind];
    return (
        <span
            aria-hidden="true"
            className={`absolute -right-2 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold ring-2 ring-surface ${fill}`}
            data-view-container-badge={containerId}
            data-view-container-badge-kind={badge.kind}
        >
            {/* The glyph is drawn at 9px, far below the size Lucide's stroke scaling assumes, so the stroke has to stay
                in screen pixels or it renders as a barely visible hairline. The two shapes differ in outline, not just
                in fill, so error and warning stay apart with no color at all. */}
            {badge.kind === 'count' ? (
                badge.text
            ) : badge.kind === 'error' ? (
                <X nonScalingStroke size={9} strokeWidth={3} />
            ) : (
                <AlertTriangle nonScalingStroke size={9} strokeWidth={2.5} />
            )}
        </span>
    );
}
