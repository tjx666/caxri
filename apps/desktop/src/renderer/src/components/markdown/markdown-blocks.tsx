import { memo, useMemo } from 'react';

import type { MarkdownBlock, MarkdownListItem } from '@caxri/markdown';
import { isSameMarkdownTree } from '@caxri/markdown';
import { Square, SquareCheck } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { CodeBlock } from './code-block';
import { InlineNodes } from './inline-nodes';
import type { MarkdownRenderContext } from './markdown-context';
import { MarkdownContext, useMarkdownContext } from './markdown-context';
import { QuoteBlock } from './quote-block';
import { TableBlock } from './table-block';

/**
 * React renderer for the closed, HTML-free Markdown subset `parseMarkdownBlocks` produces. Raw HTML, images, and
 * non-HTTP(S) destinations are already gone, so no sanitizer is involved; the one markup insertion is a code block's
 * Monaco colorization (see `CodeBlock`). Shared by extension hover cards and Agent Chat messages.
 *
 * `isStreaming` marks the last block as still being written, which keeps work that only pays off for settled content
 * (code colorization) off the block every delta changes.
 */
export function MarkdownBlocks({
    blocks,
    diagrams,
    isStreaming = false,
    onOpenFile,
    onOpenUrl,
    referenceTerminalId,
    variant = 'compact',
}: {
    blocks: readonly MarkdownBlock[];
    isStreaming?: boolean;
} & Partial<Pick<MarkdownRenderContext, 'variant'>> &
    Omit<MarkdownRenderContext, 'variant'>) {
    const context = useMemo(
        () => ({ diagrams, onOpenFile, onOpenUrl, referenceTerminalId, variant }),
        [diagrams, onOpenFile, onOpenUrl, referenceTerminalId, variant],
    );
    return (
        <MarkdownContext value={context}>
            <BlockList blocks={blocks} depth={0} isOpen={isStreaming} />
        </MarkdownContext>
    );
}

/**
 * A streamed delta re-parses the whole reply into fresh objects, but usually changes only the last block. Comparing by
 * value lets every settled block skip rendering entirely.
 */
const BlockNode = memo(
    ({ block, depth, isOpen }: { block: MarkdownBlock; depth: number; isOpen: boolean }) => {
        switch (block.type) {
            case 'paragraph': {
                return (
                    <p className="my-0">
                        <InlineNodes nodes={block.children} />
                    </p>
                );
            }
            case 'heading': {
                return <Heading block={block} />;
            }
            case 'code': {
                return <CodeBlock block={block} isOpen={isOpen} />;
            }
            case 'table': {
                return <TableBlock block={block} />;
            }
            case 'quote': {
                return (
                    <QuoteBlock block={block}>
                        <BlockList blocks={block.children} depth={depth} isOpen={isOpen} />
                    </QuoteBlock>
                );
            }
            case 'list': {
                return <ListBlock block={block} depth={depth} isOpen={isOpen} />;
            }
            case 'rule': {
                return <hr className="my-1 border-0 border-t border-solid border-border" />;
            }
        }
    },
    (previous, next) =>
        previous.depth === next.depth &&
        previous.isOpen === next.isOpen &&
        isSameMarkdownTree(previous.block, next.block),
);

/**
 * Blocks have no identity of their own; position plus type keeps a streaming reply's earlier blocks mounted while its
 * tail grows, and remounts a slot only when its kind changes.
 */
function BlockList({
    blocks,
    depth,
    isOpen,
}: {
    blocks: readonly MarkdownBlock[];
    /**
     * List nesting depth, which picks the bullet style.
     */
    depth: number;
    isOpen: boolean;
}) {
    return blocks.map((block, position) => (
        <BlockNode
            block={block}
            depth={depth}
            isOpen={isOpen && position === blocks.length - 1}
            key={`${position}:${block.type}`}
        />
    ));
}

/**
 * Transcript headings step down from the `title` tier to `base`; the type scale has no tier between, so levels 3 and
 * below differ from body text by weight alone. Compact hosts keep every heading at body size.
 */
function Heading({ block }: { block: Extract<MarkdownBlock, { type: 'heading' }> }) {
    const { variant } = useMarkdownContext();
    const level = variant === 'transcript' ? block.level : 6;
    const Tag = variant === 'transcript' ? (`h${block.level}` as const) : 'p';
    return (
        <Tag
            className={cn(
                'my-0 font-semibold text-foreground',
                level <= 2 ? 'pt-2 text-[15px] leading-6' : 'text-[13px]',
                level === 3 && 'pt-1',
            )}
        >
            <InlineNodes nodes={block.children} />
        </Tag>
    );
}

const BULLETS = ['list-disc', 'list-[circle]', 'list-[square]'] as const;
const NUMBERS = ['list-decimal', 'list-[lower-alpha]', 'list-[lower-roman]'] as const;

function ListBlock({
    block,
    depth,
    isOpen,
}: {
    block: Extract<MarkdownBlock, { type: 'list' }>;
    depth: number;
    isOpen: boolean;
}) {
    const List = block.ordered ? 'ol' : 'ul';
    const styles = block.ordered ? NUMBERS : BULLETS;
    return (
        <List
            className={cn('my-0 space-y-1 pl-5 marker:text-muted', styles[depth % styles.length])}
            start={block.start}
        >
            {block.items.map((item, itemIndex) => (
                <ListItem
                    depth={depth}
                    isOpen={isOpen && itemIndex === block.items.length - 1}
                    item={item}
                    key={itemIndex}
                />
            ))}
        </List>
    );
}

/**
 * A task item drops its bullet and shows a read-only checkbox in the bullet's gutter, so task text stays aligned with
 * its neighbors.
 */
function ListItem({
    depth,
    isOpen,
    item,
}: {
    depth: number;
    isOpen: boolean;
    item: MarkdownListItem;
}) {
    const { t } = useTranslation();
    /**
     * Blocks reset their own margins (`my-0`), which beats Tailwind v4's zero-specificity `space-y-*`, so spacing
     * between an item's blocks comes from a flex gap. The `li` itself stays a list item so it keeps its marker.
     */
    const content = (
        <div className="flex flex-col gap-1">
            <BlockList blocks={item.blocks} depth={depth + 1} isOpen={isOpen} />
        </div>
    );
    if (item.checked === undefined) return <li>{content}</li>;
    const Icon = item.checked ? SquareCheck : Square;
    return (
        <li className="relative list-none">
            <Icon
                aria-hidden="true"
                className={cn(
                    'absolute top-[3px] -left-5 size-3.5',
                    item.checked ? 'text-accent' : 'text-muted',
                )}
            />
            <span className="sr-only">
                {t(item.checked ? 'core.markdown.taskDone' : 'core.markdown.taskTodo')}
            </span>
            {content}
        </li>
    );
}
