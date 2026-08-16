import { useState } from 'react';

import { gitHubAvatarUrl } from '@caxri/utils';

import { cn } from '../../../../lib/utilities';

/**
 * Commit author avatar resolved from the author email via GitHub (GitLens-style), falling back to an initial letter
 * when the email is missing or the avatar image fails to load (offline, blocked, unknown account).
 */
export function CommitAvatar({
    author,
    email,
    size = 18,
    className,
}: {
    author: string;
    email: string;
    size?: number;
    className?: string;
}) {
    const [failed, setFailed] = useState(false);
    // 2x the rendered size so the bitmap stays sharp on Retina displays.
    const url = gitHubAvatarUrl(email, size * 2);
    if (!url || failed)
        return (
            <span
                aria-hidden="true"
                className={cn(
                    'commit-avatar-fallback grid shrink-0 place-items-center rounded-full bg-elevated text-[10px] font-semibold text-muted uppercase select-none',
                    className,
                )}
                style={{ width: size, height: size }}
            >
                {author.trim().slice(0, 1) || '?'}
            </span>
        );
    return (
        <img
            alt=""
            aria-hidden="true"
            className={cn('commit-avatar shrink-0 rounded-full bg-elevated', className)}
            height={size}
            loading="lazy"
            src={url}
            width={size}
            onError={() => setFailed(true)}
        />
    );
}
