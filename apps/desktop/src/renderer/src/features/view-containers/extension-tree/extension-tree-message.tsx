import type { ReactNode } from 'react';

import { Button } from '../../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../../components/ui/empty';

export function ExtensionTreeMessage({
    actionLabel,
    description,
    disabled,
    icon,
    onAction,
    title,
}: {
    actionLabel?: string;
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
                    tabIndex={-1}
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
