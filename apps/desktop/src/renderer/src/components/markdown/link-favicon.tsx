import { GitPullRequest, Globe } from 'lucide-react';

import { GithubMarkIcon } from '../../icons/brands/github-mark-icon';
import type { LinkSummary } from '../../lib/link-summary';
import { isGitHubHost, pullRequestLinkState } from '../../lib/link-summary';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { PULL_REQUEST_ICONS } from './pull-request-icons';

/**
 * A pull request link's icon, tinted by its state. The state comes from the Terminal reference preview, which reads
 * GitHub's REST API (not the GraphQL budget the sidebar shares), caches per number, and only answers for repositories
 * the Session already has, so a transcript cannot steer requests at an arbitrary repository. Without a Terminal to
 * scope the read, for another repository's pull request, or until it answers, the plain pull request glyph stands in
 * GitHub's pull request green: the neutral glyph keeps it distinct from a confirmed open state, while the tint still
 * reads as a pull request rather than borrowing the link text's color.
 */
function PullRequestLinkIcon({
    className,
    reference,
    terminalId,
}: {
    className: string;
    reference: NonNullable<LinkSummary['reference']>;
    terminalId: string | undefined;
}) {
    const preview = useCaxriQuery(
        'terminal.reference.preview',
        { terminalId: terminalId ?? '', reference: { kind: 'github', ...reference } },
        { enabled: terminalId !== undefined, retry: false, staleTime: 5 * 60_000 },
    );
    const state = pullRequestLinkState(preview.data);
    if (!state)
        return (
            <GitPullRequest
                aria-hidden
                className={cn(className, 'text-success')}
                data-link-icon="pull-request"
            />
        );
    const { icon: Icon, tone } = PULL_REQUEST_ICONS[state];
    return (
        <Icon
            aria-hidden
            className={cn(className, tone)}
            data-link-icon="pull-request"
            data-pull-request-state={state}
        />
    );
}

/**
 * A link's site icon: a pull request glyph tinted by its state for a GitHub pull request, the GitHub mark for the rest
 * of GitHub, the site's own `/favicon.ico` (fetched by Main, see `links.favicon`), or a globe when the site has none or
 * is served over plain HTTP.
 */
export function LinkFavicon({
    className,
    origin,
    referenceTerminalId,
    summary,
}: {
    className?: string;
    origin: string;
    /**
     * The Terminal whose Session scopes a pull request's state lookup; without one the glyph stays untinted.
     */
    referenceTerminalId?: string;
    summary: LinkSummary;
}) {
    const { host, isSecure } = summary;
    const iconClassName = cn('inline-block size-3.5 shrink-0', className);
    if (summary.kind === 'pull' && summary.reference)
        return (
            <PullRequestLinkIcon
                className={iconClassName}
                reference={summary.reference}
                terminalId={referenceTerminalId}
            />
        );
    if (isGitHubHost(host))
        return <GithubMarkIcon className={iconClassName} data-link-icon="github" />;
    if (!isSecure) return <Globe aria-hidden className={iconClassName} data-link-icon="globe" />;
    return <SiteFavicon className={iconClassName} origin={origin} />;
}

function SiteFavicon({ className, origin }: { className: string; origin: string }) {
    const favicon = useCaxriQuery(
        'links.favicon',
        { origin },
        { retry: false, staleTime: Infinity },
    );
    const dataUrl = favicon.data?.dataUrl;
    /**
     * The generic globe stands in while the icon loads (a slow or unreachable site can take the full fetch timeout) and
     * when the site has none, so a link never leads with a blank gap. The real icon fades in over it, and a cached
     * answer arrives with the first render and skips the fade.
     */
    if (!dataUrl) return <Globe aria-hidden className={className} data-link-icon="globe" />;
    return (
        <img
            alt=""
            aria-hidden
            data-link-icon="site"
            className={cn(
                className,
                'rounded-xs',
                favicon.isFetchedAfterMount &&
                    'motion-safe:animate-in motion-safe:fade-in-0 duration-(--motion-overlay-enter) ease-(--motion-ease-enter)',
            )}
            src={dataUrl}
        />
    );
}
