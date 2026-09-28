import { useMemo } from 'react';

import type { MarkdownBlock, MarkdownInline } from '@caxri/markdown';
import { parseMarkdownBlocks } from '@caxri/markdown';

type OpenUrl = (url: string) => void;

function InlineNodes({
    nodes,
    onOpenUrl,
}: {
    nodes: readonly MarkdownInline[];
    onOpenUrl: OpenUrl;
}) {
    return nodes.map((node, index) => <InlineNode key={index} node={node} onOpenUrl={onOpenUrl} />);
}

function InlineNode({ node, onOpenUrl }: { node: MarkdownInline; onOpenUrl: OpenUrl }) {
    switch (node.type) {
        case 'text': {
            return node.value;
        }
        case 'code': {
            return (
                <code className="rounded bg-surface px-1 py-px font-mono text-[11px] text-foreground">
                    {node.value}
                </code>
            );
        }
        case 'break': {
            return <br />;
        }
        case 'strong': {
            return (
                <strong className="font-semibold text-foreground">
                    <InlineNodes nodes={node.children} onOpenUrl={onOpenUrl} />
                </strong>
            );
        }
        case 'emphasis': {
            return (
                <em>
                    <InlineNodes nodes={node.children} onOpenUrl={onOpenUrl} />
                </em>
            );
        }
        case 'strikethrough': {
            return (
                <s>
                    <InlineNodes nodes={node.children} onOpenUrl={onOpenUrl} />
                </s>
            );
        }
        case 'link': {
            const { href } = node;
            if (!href) return <InlineNodes nodes={node.children} onOpenUrl={onOpenUrl} />;
            return (
                <button
                    className="cursor-pointer border-0 bg-transparent p-0 text-left text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
                    title={href}
                    type="button"
                    onClick={() => onOpenUrl(href)}
                >
                    <InlineNodes nodes={node.children} onOpenUrl={onOpenUrl} />
                </button>
            );
        }
    }
}

function BlockNodes({
    blocks,
    onOpenUrl,
}: {
    blocks: readonly MarkdownBlock[];
    onOpenUrl: OpenUrl;
}) {
    return blocks.map((block, index) => (
        <BlockNode block={block} key={index} onOpenUrl={onOpenUrl} />
    ));
}

function BlockNode({ block, onOpenUrl }: { block: MarkdownBlock; onOpenUrl: OpenUrl }) {
    switch (block.type) {
        case 'paragraph': {
            return (
                <p className="my-0">
                    <InlineNodes nodes={block.children} onOpenUrl={onOpenUrl} />
                </p>
            );
        }
        case 'heading': {
            return (
                <p className="my-0 font-semibold text-foreground">
                    <InlineNodes nodes={block.children} onOpenUrl={onOpenUrl} />
                </p>
            );
        }
        case 'code': {
            return (
                <pre className="my-0 overflow-x-auto rounded bg-surface px-2 py-1 font-mono text-[11px] leading-4 text-foreground">
                    {block.value}
                </pre>
            );
        }
        case 'quote': {
            return (
                <blockquote className="my-0 space-y-1.5 border-0 border-l-2 border-solid border-border pl-2">
                    <BlockNodes blocks={block.children} onOpenUrl={onOpenUrl} />
                </blockquote>
            );
        }
        case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
                <List
                    className={`my-0 space-y-0.5 pl-5 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
                >
                    {block.items.map((item, itemIndex) => (
                        <li className="space-y-1" key={itemIndex}>
                            <BlockNodes blocks={item} onOpenUrl={onOpenUrl} />
                        </li>
                    ))}
                </List>
            );
        }
        case 'rule': {
            return <hr className="my-0 border-0 border-t border-solid border-border" />;
        }
    }
}

/**
 * Renders an extension's Markdown tooltip body as React text nodes. `parseMarkdownBlocks` has already dropped raw HTML,
 * images, and non-HTTP(S) destinations, so no sanitizer or `dangerouslySetInnerHTML` is involved.
 */
export function ExtensionTreeTooltipMarkdown({
    source,
    onOpenUrl,
}: {
    source: string;
    onOpenUrl: OpenUrl;
}) {
    const blocks = useMemo(() => parseMarkdownBlocks(source), [source]);
    if (blocks.length === 0) return null;
    return (
        <div className="mt-1 max-h-80 space-y-1.5 overflow-y-auto text-[12px] leading-5 wrap-anywhere text-muted">
            <BlockNodes blocks={blocks} onOpenUrl={onOpenUrl} />
        </div>
    );
}
