import type { ReactNode } from 'react';
import { useState } from 'react';

import { BookMarked, CircleDot, ExternalLink, GitPullRequest, MessagesSquare } from 'lucide-react';

import type { LinkSummary } from '../../lib/link-summary';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card';
import { LinkFavicon } from './link-favicon';

const GITHUB_KIND_ICONS = {
    pull: GitPullRequest,
    issue: CircleDot,
    discussion: MessagesSquare,
    repository: BookMarked,
} as const;

/**
 * A web link in a transcript or a user's message: the site's icon ahead of the text, a dotted underline, and a hover
 * card naming the site with an Open action, modeled on the Codex app. The card previews the page (its share image,
 * title, and description) once Main has read them; until then, or when the page declares none, it names where on the
 * site the link leads.
 */
export function WebLink({
    children,
    className,
    href,
    referenceTerminalId,
    summary,
    onOpen,
}: {
    children: ReactNode;
    /**
     * The trigger's text treatment, so a link keeps the color of the text it sits in.
     */
    className?: string;
    href: string;
    /**
     * The Terminal whose Session scopes a pull request link's state lookup.
     */
    referenceTerminalId?: string;
    summary: LinkSummary;
    onOpen: (url: string) => void;
}) {
    const origin = new URL(href).origin;
    return (
        <HoverCard>
            <HoverCardTrigger
                closeDelay={120}
                delay={350}
                render={
                    <button
                        className={cn(
                            'cursor-pointer border-0 bg-transparent p-0 text-left underline decoration-dotted underline-offset-3 hover:decoration-solid focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent',
                            className,
                        )}
                        type="button"
                        onClick={() => onOpen(href)}
                    />
                }
            >
                <LinkFavicon
                    className="-mt-0.5 mr-1 align-middle"
                    origin={origin}
                    referenceTerminalId={referenceTerminalId}
                    summary={summary}
                />
                {children}
            </HoverCardTrigger>
            <HoverCardContent
                align="start"
                className="w-90 overflow-hidden p-0 whitespace-normal"
                side="bottom"
            >
                <div className="flex items-center gap-2 px-3 py-2">
                    <LinkFavicon
                        className="text-muted"
                        origin={origin}
                        referenceTerminalId={referenceTerminalId}
                        summary={summary}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                        {summary.host}
                    </span>
                    <button
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-foreground transition-colors duration-150 hover:bg-surface focus-visible:outline focus-visible:outline-accent"
                        type="button"
                        onClick={() => onOpen(href)}
                    >
                        Open
                        <ExternalLink aria-hidden className="size-3.5" />
                    </button>
                </div>
                {summary.isSecure ? (
                    <PagePreview href={href} summary={summary} />
                ) : (
                    <LinkDetail summary={summary} />
                )}
            </HoverCardContent>
        </HoverCard>
    );
}

/**
 * Mounted only while the card is open, so a transcript full of links reads no page until the user hovers one.
 */
function PagePreview({ href, summary }: { href: string; summary: LinkSummary }) {
    const preview = useCaxriQuery(
        'links.preview',
        { url: href },
        { retry: false, staleTime: Infinity },
    );
    const [hasImageFailed, setHasImageFailed] = useState(false);
    const { title, description, imageUrl } = preview.data ?? {};
    if (!title && !description && !imageUrl) return <LinkDetail summary={summary} />;
    return (
        <>
            {imageUrl && !hasImageFailed && (
                <img
                    alt=""
                    className="motion-safe:animate-in motion-safe:fade-in-0 block aspect-[1.91/1] w-full border-t border-border bg-background object-cover"
                    src={imageUrl}
                    onError={() => setHasImageFailed(true)}
                />
            )}
            {(title !== undefined || description !== undefined) && (
                <div className="flex flex-col gap-0.5 border-t border-border px-3 py-2.5 text-[12px] leading-4">
                    {title && (
                        <span className="line-clamp-2 font-medium text-foreground">{title}</span>
                    )}
                    {description && <span className="line-clamp-3 text-muted">{description}</span>}
                </div>
            )}
        </>
    );
}

function LinkDetail({ summary }: { summary: LinkSummary }) {
    if (!summary.detail) return null;
    const DetailIcon = summary.kind && GITHUB_KIND_ICONS[summary.kind];
    return (
        <div className="flex items-start gap-2 border-t border-border px-3 py-2 text-[12px] leading-4 wrap-anywhere text-muted">
            {DetailIcon && <DetailIcon aria-hidden className="mt-px size-3.5 shrink-0" />}
            <span className="min-w-0">{summary.detail}</span>
        </div>
    );
}
