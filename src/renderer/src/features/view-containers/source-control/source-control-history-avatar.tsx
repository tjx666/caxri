import { useState } from 'react';

import type { SourceControlHistoryPage } from '@caxri/protocol';

import { cn } from '../../../lib/utilities';

type SourceControlHistoryItem = SourceControlHistoryPage['items'][number];

export function SourceControlHistoryAvatar({
    className,
    item,
    size = 18,
}: {
    className?: string;
    item: SourceControlHistoryItem;
    size?: number;
}) {
    const [failed, setFailed] = useState(false);
    if (failed || !item.avatarUrl)
        return (
            <span
                aria-hidden="true"
                className={cn(
                    'commit-avatar-fallback grid shrink-0 place-items-center rounded-full bg-elevated text-[10px] font-semibold text-muted uppercase select-none',
                    className,
                )}
                style={{ width: size, height: size }}
            >
                {item.authorFallback}
            </span>
        );
    return (
        <img
            alt=""
            aria-hidden="true"
            className={cn(
                'commit-avatar shrink-0 rounded-full bg-elevated object-cover',
                className,
            )}
            height={size}
            loading="lazy"
            src={item.avatarUrl}
            style={{ width: size, height: size }}
            width={size}
            onError={() => setFailed(true)}
        />
    );
}
