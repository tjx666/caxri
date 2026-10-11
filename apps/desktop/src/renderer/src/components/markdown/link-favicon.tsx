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
    if (isGitHubHost(host)) return <GithubMarkIcon className={iconClassName} />;
    if (!isSecure) return <Globe aria-hidden className={iconClassName} />;
    return <SiteFavicon className={iconClassName} origin={origin} />;
}

function SiteFavicon({ className, origin }: { className: string; origin: string }) {
    const favicon = useCaxriQuery(
        'links.favicon',
        { origin },
        { retry: false, staleTime: Infinity },
    );
    const dataUrl = favicon.data?.dataUrl;
    if (!dataUrl && favicon.isSuccess) return <Globe aria-hidden className={className} />;
    /**
     * Holds the icon's place while it loads and fades it in, so a slow site neither shifts the line nor pops its icon
     * into text the user is reading. A cached answer arrives with the first render and skips the fade.
     */
    return (
        <img
            alt=""
            aria-hidden
            className={cn(
                className,
                'rounded-xs',
                favicon.isFetchedAfterMount && 'motion-safe:animate-in motion-safe:fade-in-0',
                !dataUrl && 'invisible',
            )}
            src={dataUrl}
        />
    );
}
