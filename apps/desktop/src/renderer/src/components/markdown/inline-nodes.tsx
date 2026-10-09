import type { MarkdownInline } from '@caxri/markdown';

import { cn } from '../../lib/utilities';
import { useMarkdownContext } from './markdown-context';

const LINK_CLASS_NAME =
    'cursor-pointer border-0 bg-transparent p-0 text-left text-accent underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent';

export function InlineNodes({ nodes }: { nodes: readonly MarkdownInline[] }) {
    return nodes.map((node, position) => (
        <InlineNode key={`${position}:${node.type}`} node={node} />
    ));
}

function InlineCode({ node }: { node: Extract<MarkdownInline, { type: 'code' }> }) {
    const { onOpenFile, variant } = useMarkdownContext();
    const className = cn(
        'rounded bg-surface px-1 py-px font-mono text-foreground',
        variant === 'transcript' ? 'text-[12px]' : 'text-[11px]',
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
                'cursor-pointer border-0 underline-offset-2 hover:text-accent hover:underline focus-visible:outline focus-visible:outline-accent',
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
    const { onOpenFile, onOpenUrl } = useMarkdownContext();
    const { file, href } = node;
    const open = href ? () => onOpenUrl(href) : file && onOpenFile && (() => onOpenFile(file));
    if (!open) return <InlineNodes nodes={node.children} />;
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
