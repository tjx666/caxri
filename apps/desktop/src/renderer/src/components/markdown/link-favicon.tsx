import { Globe } from 'lucide-react';

import { GithubMarkIcon } from '../../icons/brands/github-mark-icon';
import { isGitHubHost } from '../../lib/link-summary';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';

/**
 * A link's site icon: the GitHub mark, the site's own `/favicon.ico` (fetched by Main, see `links.favicon`), or a globe
 * when the site has none or is served over plain HTTP.
 */
export function LinkFavicon({
    className,
    host,
    isSecure,
    origin,
}: {
    className?: string;
    host: string;
    isSecure: boolean;
    origin: string;
}) {
    const iconClassName = cn('inline-block size-3.5 shrink-0', className);
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
                favicon.isFetchedAfterMount && 'motion-safe:animate-in motion-safe:fade-in-0',
            )}
            src={dataUrl}
        />
    );
}
