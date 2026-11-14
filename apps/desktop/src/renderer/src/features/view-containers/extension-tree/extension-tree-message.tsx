import type { ReactNode } from 'react';

import { Button } from '../../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../../components/ui/empty';

/**
 * The quiet full-surface state DESIGN.md prescribes for a tree that has nothing to list. Inside `role="tree"` it is a
 * `message` row whose focus belongs to the row, so its action stays out of the Tab order; a root load failure renders
 * it outside the tree instead, where the action must be focusable to stay reachable.
 */
export function ExtensionTreeMessage({
    actionLabel,
    isActionFocusable = false,
    description,
    disabled,
    icon,
    onAction,
    title,
}: {
    actionLabel?: string;
    isActionFocusable?: boolean;
    description?: string;
    disabled: boolean;
    icon: ReactNode;
    onAction: () => void;
    title: string;
}) {
    return (
        <Empty className="min-h-40 gap-2 p-4">
            <EmptyMedia>{icon}</EmptyMedia>
            <EmptyTitle className="max-w-full break-words">{title}</EmptyTitle>
            {description && (
                <p
                    className="m-0 max-w-64 text-[11px] leading-[1.45] text-pretty break-words text-muted"
                    data-slot="empty-description"
                >
                    {description}
                </p>
            )}
            {actionLabel && (
                <Button
                    aria-busy={disabled || undefined}
                    disabled={disabled}
                    size="sm"
                    tabIndex={isActionFocusable ? undefined : -1}
                    variant="secondary"
                    onClick={() => {
                        onAction();
                    }}
                >
                    {actionLabel}
                </Button>
            )}
        </Empty>
    );
}
