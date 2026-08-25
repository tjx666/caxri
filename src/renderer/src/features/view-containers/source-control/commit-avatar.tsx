import { useState } from 'react';

import { gitHubAvatarUrl, shouldFetchGitHubAvatar } from '@caxri/utils';
import type { GitRepositorySummary } from '@shared/types';
import { useQuery } from '@tanstack/react-query';

import { cn } from '../../../lib/utilities';
import { useSettings } from '../../../stores/selectors';
import { useControlledView, useSourceControlClient } from '../controlled-view-context';
import { controlledViewQueryKey } from '../view-operation-client';

/**
 * Commit author avatar resolved from the author email via GitHub (GitLens-style), falling back to an initial letter
 * when the email is missing, the lookup is not authorized, or the avatar image fails to load (offline, blocked, unknown
 * account). The GitHub lookup only ever runs when `git.fetchGitHubAvatars` is on AND the repository's `origin` remote
 * resolves to exactly `github.com` — see {@link shouldFetchGitHubAvatar}; an unknown, missing, or GitHub Enterprise
 * remote host never sends the author's email anywhere.
 */
export function CommitAvatar({
    author,
    email,
    repository,
    size = 18,
    className,
}: {
    author: string;
    email: string;
    repository: Pick<GitRepositorySummary, 'id'>;
    size?: number;
    className?: string;
}) {
    const { viewId } = useControlledView();
    const client = useSourceControlClient();
    const [failed, setFailed] = useState(false);
    const fetchAvatarsSetting = useSettings()?.['git.fetchGitHubAvatars'] ?? false;
    const arguments_ = { repositoryId: repository.id };
    const remoteHostQuery = useQuery({
        queryKey: controlledViewQueryKey(viewId, 'git.remoteHost', arguments_),
        queryFn: ({ signal }) => client.remoteHost(repository.id, signal),
        enabled: fetchAvatarsSetting,
        staleTime: Infinity,
    });
    const canFetch = shouldFetchGitHubAvatar(remoteHostQuery.data, fetchAvatarsSetting);
    // 2x the rendered size so the bitmap stays sharp on Retina displays.
    const url = canFetch ? gitHubAvatarUrl(email, size * 2) : undefined;
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
            className={cn(
                'commit-avatar shrink-0 rounded-full bg-elevated object-cover',
                className,
            )}
            height={size}
            loading="lazy"
            src={url}
            // Inline size wins over any global img sizing rules (e.g. max-width/height:auto resets),
            // which otherwise let the bitmap render non-square and look stretched.
            style={{ width: size, height: size }}
            width={size}
            onError={() => setFailed(true)}
        />
    );
}
