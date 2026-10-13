import type { ReactNode } from 'react';
import { useState } from 'react';

import { BookMarked, CircleDot, ExternalLink, GitPullRequest, MessagesSquare } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { LinearStatusIcon } from '../../icons/linear/linear-status-icon';
import type { LinkSummary } from '../../lib/link-summary';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { writeToClipboardWithFeedback } from '../copy-feedback';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card';
import { CopyIconButton } from './copy-icon-button';
import { useLinkContextMenu } from './link-context-menu';
import { LinkFavicon } from './link-favicon';

const GITHUB_KIND_ICONS = {
    pull: GitPullRequest,
    issue: CircleDot,
    discussion: MessagesSquare,
    repository: BookMarked,
} as const;

/**
 * A web link in a transcript or a user's message: the site's icon ahead of the text, the caller's text treatment, and a
 * hover card showing the full address (cut to one line) with Copy Link and Open actions, modeled on the Codex app. The
 * card previews the page (its share image, title, and description) once Main has read them; until then, or when the
 * page declares none, it names where on the site the link leads. A right-click offers Open Link and Copy Link.
 */
export function WebLink({
    children,
    className,
    href,
    referenceTerminalId,
    side = 'bottom',
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
     * The Terminal a pull request link's state lookup is routed through.
     */
    referenceTerminalId?: string;
    /**
     * Where the card opens. Below the link by default; a caller whose own controls sit right below the text (a user
     * message's hover action row) opens it above, so the card never covers them.
     */
    side?: 'top' | 'bottom';
    summary: LinkSummary;
    onOpen: (url: string) => void;
}) {
    const { t } = useTranslation();
    const origin = new URL(href).origin;
    const onContextMenu = useLinkContextMenu(href, onOpen);
    return (
        <HoverCard>
            <HoverCardTrigger
                closeDelay={120}
                delay={350}
                render={
                    <button
                        className={cn(
                            'cursor-pointer border-0 bg-transparent p-0 text-left underline-offset-3 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent',
                            className,
                        )}
                        type="button"
                        onClick={() => onOpen(href)}
                        onContextMenu={onContextMenu}
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
                side={side}
            >
                <div className="flex items-center gap-2 px-3 py-2">
                    <LinkFavicon
                        className="text-muted"
                        origin={origin}
                        referenceTerminalId={referenceTerminalId}
                        summary={summary}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted select-text">
                        {href}
                    </span>
                    <CopyIconButton
                        className="shrink-0"
                        copy={() => writeToClipboardWithFeedback(navigator.clipboard, href)}
                        label={t('agentChat.link.copy')}
                    />
                    <button
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-foreground transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-accent"
                        type="button"
                        onClick={() => onOpen(href)}
                    >
                        {t('common.open')}
                        <ExternalLink aria-hidden className="size-3.5" />
                    </button>
                </div>
                {summary.linearIssue ? (
                    <LinearIssuePreview href={href} issue={summary.linearIssue} summary={summary} />
                ) : summary.isSecure ? (
                    <PagePreview key={href} href={href} summary={summary} />
                ) : (
                    <LinkDetail summary={summary} />
                )}
            </HoverCardContent>
        </HoverCard>
    );
}

/**
 * Mounted only while the card is open, so a transcript full of links reads no page until the user hovers one.
 *
 * The card only ever grows, the way the Codex app's does: the header alone while the page is read, the text once it
 * arrives, and the share image only after it has decoded. Reserving the image's box up front showed a blank panel that
 * collapsed again whenever the image was slow or broken.
 */
function PagePreview({ href, summary }: { href: string; summary: LinkSummary }) {
    const preview = useCaxriQuery(
        'links.preview',
        { url: href },
        { retry: false, staleTime: Infinity },
    );
    const [imageState, setImageState] = useState<'loading' | 'loaded' | 'failed'>('loading');
    if (preview.isPending) return null;
    const { title, description, imageUrl } = preview.data ?? {};
    const hasImage = imageUrl !== undefined && imageState !== 'failed';
    if (!title && !description && !hasImage) return <LinkDetail summary={summary} />;
    return (
        <>
            {hasImage && (
                <img
                    alt=""
                    className={cn(
                        'motion-safe:animate-in motion-safe:fade-in-0 block aspect-[1.91/1] w-full border-t border-border bg-background object-cover duration-(--motion-overlay-enter) ease-(--motion-ease-enter)',
                        imageState !== 'loaded' && 'hidden',
                    )}
                    src={imageUrl}
                    onError={() => setImageState('failed')}
                    onLoad={() => setImageState('loaded')}
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

/**
 * A Linear issue page renders only after sign-in, so an anonymous page read returns Linear's generic card. The Server
 * asks the signed-in `linear` CLI instead and the card shows what the Status panel would: the workflow state in the
 * workspace's color, the title, and the description's opening. When it cannot answer (no CLI, no credential for that
 * workspace), the generic page preview stands in.
 */
function LinearIssuePreview({
    href,
    issue,
    summary,
}: {
    href: string;
    issue: NonNullable<LinkSummary['linearIssue']>;
    summary: LinkSummary;
}) {
    const preview = useCaxriQuery('projectStatus.linearIssue', issue, {
        retry: false,
        staleTime: 5 * 60_000,
    });
    // The header alone while the CLI answers; reading the page as well would flash Linear's generic card first.
    if (preview.isPending) return null;
    const data = preview.data;
    if (!data) return <PagePreview key={href} href={href} summary={summary} />;
    return (
        <div className="flex flex-col gap-1 border-t border-border px-3 py-2.5 text-[12px] leading-4">
            <span className="flex min-w-0 items-center gap-1.5 text-muted">
                <LinearStatusIcon
                    className="shrink-0"
                    size={14}
                    kind={data.stateType ?? 'backlog'}
                    style={data.stateColor ? { color: data.stateColor } : undefined}
                />
                <span className="shrink-0 font-mono text-[11px]">{data.identifier}</span>
                {data.state && <span className="min-w-0 truncate">{data.state}</span>}
            </span>
            <span className="line-clamp-2 font-medium text-foreground">{data.title}</span>
            {data.excerpt && <span className="line-clamp-3 text-muted">{data.excerpt}</span>}
        </div>
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
