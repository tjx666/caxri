import { useEffect, useState } from 'react';

import type { MarkdownBlock, MarkdownInline } from '@caxri/markdown';
import { Check, Copy } from 'lucide-react';

import { cn } from '../lib/utilities';
import type { CopyFeedbackStatus } from './copy-feedback';
import {
    COPY_FEEDBACK_RESET_MS,
    copyButtonLabel,
    writeToClipboardWithFeedback,
} from './copy-feedback';

type OpenUrl = (url: string) => void;

/**
 * Host-specific rendering choices. Hover cards keep the compact defaults; a conversation transcript opts into the
 * controls a reader there needs.
 */
interface MarkdownBlocksOptions {
    /**
     * Show the fence language and a Copy button on code blocks.
     */
    isCodeCopyable?: boolean;
}

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

/**
 * React renderer for the closed, HTML-free Markdown subset `parseMarkdownBlocks` produces. Raw HTML, images, and
 * non-HTTP(S) destinations are already gone, so no sanitizer or `dangerouslySetInnerHTML` is involved. Shared by
 * extension hover cards and Agent Chat messages.
 */
export function MarkdownBlocks({
    blocks,
    onOpenUrl,
    options = {},
}: {
    blocks: readonly MarkdownBlock[];
    onOpenUrl: OpenUrl;
    options?: MarkdownBlocksOptions;
}) {
    // Blocks have no identity of their own; position plus type keeps a streaming reply's earlier blocks mounted while
    // its tail grows, and remounts a slot only when its kind changes.
    return blocks.map((block, position) => (
        <BlockNode
            block={block}
            key={`${position}:${block.type}`}
            options={options}
            onOpenUrl={onOpenUrl}
        />
    ));
}

function CodeBlock({
    block,
    isCopyable,
}: {
    block: Extract<MarkdownBlock, { type: 'code' }>;
    isCopyable: boolean;
}) {
    const [status, setStatus] = useState<CopyFeedbackStatus>('idle');
    useEffect(() => {
        if (status === 'idle') return;
        const timer = setTimeout(() => setStatus('idle'), COPY_FEEDBACK_RESET_MS);
        return () => clearTimeout(timer);
    }, [status]);
    const code = (
        <pre className="my-0 overflow-x-auto rounded bg-surface px-2 py-1 font-mono text-[11px] leading-4 text-foreground">
            {block.value}
        </pre>
    );
    if (!isCopyable) return code;
    const copy = async (): Promise<void> => {
        setStatus(await writeToClipboardWithFeedback(navigator.clipboard, block.value));
    };
    const label = copyButtonLabel(status, 'Copy code');
    return (
        <div className="group/code relative">
            {code}
            <div className="absolute top-0.5 right-0.5 flex items-center gap-1 opacity-0 transition-opacity group-focus-within/code:opacity-100 group-hover/code:opacity-100">
                {block.language && (
                    <span className="font-mono text-[10px] text-muted">{block.language}</span>
                )}
                <button
                    aria-label={label}
                    className="flex size-5 cursor-pointer items-center justify-center rounded border-0 bg-surface text-muted hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                    title={label}
                    type="button"
                    onClick={() => {
                        // eslint-disable-next-line no-void -- the helper resolves to a status and never rejects
                        void copy();
                    }}
                >
                    {status === 'copied' ? (
                        <Check className="size-3" />
                    ) : (
                        <Copy className="size-3" />
                    )}
                </button>
            </div>
        </div>
    );
}

const alignClassName = {
    center: 'text-center',
    left: 'text-left',
    right: 'text-right',
} as const;

function TableBlock({
    block,
    onOpenUrl,
}: {
    block: Extract<MarkdownBlock, { type: 'table' }>;
    onOpenUrl: OpenUrl;
}) {
    const cellClassName = (column: number) =>
        cn(
            'border-0 border-b border-solid border-border px-2 py-1 align-top',
            alignClassName[block.align[column] ?? 'left'],
        );
    return (
        <div className="overflow-x-auto">
            <table className="border-collapse text-[12px] leading-5">
                <thead>
                    <tr>
                        {block.header.map((cell, column) => (
                            <th
                                className={cn(
                                    cellClassName(column),
                                    'font-semibold text-foreground',
                                )}
                                key={column}
                                scope="col"
                            >
                                <InlineNodes nodes={cell} onOpenUrl={onOpenUrl} />
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {block.rows.map((row, rowIndex) => (
                        <tr key={rowIndex}>
                            {row.map((cell, column) => (
                                <td className={cellClassName(column)} key={column}>
                                    <InlineNodes nodes={cell} onOpenUrl={onOpenUrl} />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function BlockNode({
    block,
    onOpenUrl,
    options,
}: {
    block: MarkdownBlock;
    onOpenUrl: OpenUrl;
    options: MarkdownBlocksOptions;
}) {
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
            return <CodeBlock block={block} isCopyable={options.isCodeCopyable === true} />;
        }
        case 'table': {
            return <TableBlock block={block} onOpenUrl={onOpenUrl} />;
        }
        case 'quote': {
            return (
                <blockquote className="my-0 space-y-1.5 border-0 border-l-2 border-solid border-border pl-2">
                    <MarkdownBlocks
                        blocks={block.children}
                        options={options}
                        onOpenUrl={onOpenUrl}
                    />
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
                            <MarkdownBlocks blocks={item} options={options} onOpenUrl={onOpenUrl} />
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
