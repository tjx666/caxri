import type { MarkdownInline } from '@caxri/markdown';
import { BookMarked, CircleDot, ExternalLink, GitPullRequest, MessagesSquare } from 'lucide-react';

import type { LinkSummary } from '../../lib/link-summary';
import { linkSummary } from '../../lib/link-summary';
import { cn } from '../../lib/utilities';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card';
import { LinkFavicon } from './link-favicon';
import { useMarkdownContext } from './markdown-context';

const GITHUB_KIND_ICONS = {
    pull: GitPullRequest,
    issue: CircleDot,
    discussion: MessagesSquare,
    repository: BookMarked,
} as const;

const LINK_CLASS_NAME =
    'cursor-pointer border-0 bg-transparent p-0 text-left text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent';

export function InlineNodes({ nodes }: { nodes: readonly MarkdownInline[] }) {
    return nodes.map((node, position) => (
        <InlineNode key={`${position}:${node.type}`} node={node} />
    ));
}

function InlineCode({ node }: { node: Extract<MarkdownInline, { type: 'code' }> }) {
    const { onOpenFile, variant } = useMarkdownContext();
    /**
     * A transcript sits on the pane background, where a `--surface` chip reads as a hole; the lifted `--elevated` chip
     * matches how the Codex app sets code apart in its Dracula transcript. Compact hover cards already sit on
     * `--elevated`, so they keep the recessed chip.
     */
    const className = cn(
        'rounded border-0 px-1 py-px font-mono text-foreground',
        variant === 'transcript' ? 'bg-elevated text-[12px]' : 'bg-surface text-[11px]',
    );
    const { file } = node;
    if (!file || !onOpenFile) return <code className={className}>{node.value}</code>;
    /**
     * A cited path reads as code first and as a link on hover, so prose full of paths does not turn into a wall of
     * accent color.
     */
    return (
        <button
            className={cn(
                className,
                'cursor-pointer underline-offset-2 hover:text-accent hover:underline focus-visible:outline focus-visible:outline-accent',
            )}
            title={`Open ${file}`}
            type="button"
            onClick={() => onOpenFile(file)}
        >
            {node.value}
        </button>
    );
}

function InlineLink({ node }: { node: Extract<MarkdownInline, { type: 'link' }> }) {
    const { onOpenFile, onOpenUrl, variant } = useMarkdownContext();
    const { file, href } = node;
    const open = href ? () => onOpenUrl(href) : file && onOpenFile && (() => onOpenFile(file));
    if (!open) return <InlineNodes nodes={node.children} />;
    const summary = href && variant === 'transcript' ? linkSummary(href) : undefined;
    if (href && summary) return <WebLink href={href} node={node} summary={summary} />;
    return (
        <button
            className={LINK_CLASS_NAME}
            title={href ?? `Open ${file}`}
            type="button"
            onClick={open}
        >
            <InlineNodes nodes={node.children} />
        </button>
    );
}

/**
 * A transcript's web link: the site's icon ahead of the text, a dotted underline, and a hover card naming the site and
 * where on it the link leads, with an Open action, modeled on the Codex app.
 */
function WebLink({
    href,
    node,
    summary,
}: {
    href: string;
    node: Extract<MarkdownInline, { type: 'link' }>;
    summary: LinkSummary;
}) {
    const { onOpenUrl } = useMarkdownContext();
    const origin = new URL(href).origin;
    const DetailIcon = summary.kind && GITHUB_KIND_ICONS[summary.kind];
    return (
        <HoverCard>
            <HoverCardTrigger
                closeDelay={120}
                delay={350}
                render={
                    <button
                        className={cn(
                            LINK_CLASS_NAME,
                            'underline decoration-dotted underline-offset-3 hover:decoration-solid',
                        )}
                        type="button"
                        onClick={() => onOpenUrl(href)}
                    />
                }
            >
                <LinkFavicon
                    className="-mt-0.5 mr-1 align-middle"
                    host={summary.host}
                    isSecure={summary.isSecure}
                    origin={origin}
                />
                <InlineNodes nodes={node.children} />
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-80 p-0" side="bottom">
                <div className="flex items-center gap-2 px-3 py-2">
                    <LinkFavicon
                        className="text-muted"
                        host={summary.host}
                        isSecure={summary.isSecure}
                        origin={origin}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
                        {summary.host}
                    </span>
                    <button
                        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-foreground transition-colors duration-150 hover:bg-surface focus-visible:outline focus-visible:outline-accent"
                        type="button"
                        onClick={() => onOpenUrl(href)}
                    >
                        Open
                        <ExternalLink aria-hidden className="size-3.5" />
                    </button>
                </div>
                {summary.detail && (
                    <div className="flex items-start gap-2 border-t border-border px-3 py-2 text-[12px] leading-4 wrap-anywhere text-muted">
                        {DetailIcon && (
                            <DetailIcon aria-hidden className="mt-px size-3.5 shrink-0" />
                        )}
                        <span className="min-w-0">{summary.detail}</span>
                    </div>
                )}
            </HoverCardContent>
        </HoverCard>
    );
}

function InlineNode({ node }: { node: MarkdownInline }) {
    switch (node.type) {
        case 'text': {
            return node.value;
        }
        case 'code': {
            return <InlineCode node={node} />;
        }
        case 'break': {
            return <br />;
        }
        case 'strong': {
            return (
                <strong className="font-semibold text-foreground">
                    <InlineNodes nodes={node.children} />
                </strong>
            );
        }
        case 'emphasis': {
            return (
                <em>
                    <InlineNodes nodes={node.children} />
                </em>
            );
        }
        case 'strikethrough': {
            return (
                <s>
                    <InlineNodes nodes={node.children} />
                </s>
            );
        }
        case 'link': {
            return <InlineLink node={node} />;
        }
    }
}
