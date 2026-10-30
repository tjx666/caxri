import { useMemo } from 'react';

import type { MarkdownInline } from '@caxri/markdown';

import { useTranslation } from '../../i18n';
import { linkSummary } from '../../lib/link-summary';
import { cn } from '../../lib/utilities';
import { Tooltip } from '../ui/tooltip';
import { InlineButton } from './inline-button';
import { MarkdownContext, useMarkdownContext } from './markdown-context';
import { referenceMentionSegments } from './reference-mentions';
import { RevealingText } from './revealing-text';
import { WebLink } from './web-link';

const LINK_CLASS_NAME =
    'cursor-pointer text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent';

export function InlineNodes({ nodes }: { nodes: readonly MarkdownInline[] }) {
    return nodes.map((node, position) => (
        <InlineNode key={`${position}:${node.type}`} node={node} />
    ));
}

function InlineCode({ node }: { node: Extract<MarkdownInline, { type: 'code' }> }) {
    const { t } = useTranslation();
    const { onOpenFile, skills, variant } = useMarkdownContext();
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
    /**
     * A skill name wins over a path reading: `/commit` parses as an absolute path, but next to a known skill it is the
     * invocation an Agent cites, and a skill name never carries the extension a bare file name needs.
     */
    const invocation = skills?.match(node.value);
    if (skills && invocation)
        return <skills.Reference className={className} code={node.value} invocation={invocation} />;
    if (!file || !onOpenFile) return <code className={className}>{node.value}</code>;
    /**
     * A cited path reads as code first and as a link on hover, so prose full of paths does not turn into a wall of
     * accent color.
     */
    return (
        <Tooltip content={t('core.markdown.openFile', { file })}>
            <InlineButton
                className={cn(
                    className,
                    'cursor-pointer underline-offset-2 hover:text-accent hover:underline focus-visible:outline focus-visible:outline-accent',
                )}
                onClick={() => onOpenFile(file)}
            >
                {node.value}
            </InlineButton>
        </Tooltip>
    );
}

function InlineLink({ node }: { node: Extract<MarkdownInline, { type: 'link' }> }) {
    const context = useMarkdownContext();
    const { onOpenFile, onOpenUrl, referenceTerminalId, variant } = context;
    // A `#123` inside a link's own text already opens that link; it must not nest a second one.
    const labelContext = useMemo(() => ({ ...context, references: undefined }), [context]);
    const { file, href } = node;
    const open = href ? () => onOpenUrl(href) : file && onOpenFile && (() => onOpenFile(file));
    if (!open) return <InlineNodes nodes={node.children} />;
    const summary = href && variant === 'transcript' ? linkSummary(href) : undefined;
    if (href && summary)
        return (
            <WebLink
                // No underline, as in the Codex app: the color and the site icon already mark the link.
                className="text-accent hover:underline"
                href={href}
                referenceTerminalId={referenceTerminalId}
                summary={summary}
                onOpen={onOpenUrl}
            >
                <MarkdownContext value={labelContext}>
                    <InlineNodes nodes={node.children} />
                </MarkdownContext>
            </WebLink>
        );
    return (
        <Tooltip content={href ?? `Open ${file}`}>
            <InlineButton className={LINK_CLASS_NAME} onClick={open}>
                <MarkdownContext value={labelContext}>
                    <InlineNodes nodes={node.children} />
                </MarkdownContext>
            </InlineButton>
        </Tooltip>
    );
}

/**
 * Plain text, with each `#123` or `ENG-123` the conversation's links resolve drawn as that link. A reply still
 * streaming keeps its mentions as text so splitting never restarts its fade-in; they turn into links once it settles.
 */
function InlineText({ value }: { value: string }) {
    const { onOpenUrl, referenceTerminalId, references, revealSince } = useMarkdownContext();
    if (revealSince !== undefined) return <RevealingText revealSince={revealSince} value={value} />;
    const segments = references && referenceMentionSegments(value, references);
    if (!segments) return value;
    return segments.map((segment, position) => {
        if (segment.kind === 'text') return segment.text;
        const summary = linkSummary(segment.href);
        if (!summary) return segment.text;
        return (
            <WebLink
                className="text-accent hover:underline"
                href={segment.href}
                key={position}
                referenceTerminalId={referenceTerminalId}
                summary={summary}
                onOpen={onOpenUrl}
            >
                {segment.text}
            </WebLink>
        );
    });
}

function InlineNode({ node }: { node: MarkdownInline }) {
    switch (node.type) {
        case 'text': {
            return <InlineText value={node.value} />;
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
