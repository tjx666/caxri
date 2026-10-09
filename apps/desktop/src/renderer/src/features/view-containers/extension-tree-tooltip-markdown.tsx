import { useMemo } from 'react';

import { parseMarkdownBlocks } from '@caxri/markdown';

import { MarkdownBlocks } from '../../components/markdown-blocks';

/**
 * Renders an extension's Markdown tooltip body as React text nodes through the shared {@link MarkdownBlocks}.
 */
export function ExtensionTreeTooltipMarkdown({
    source,
    onOpenUrl,
}: {
    source: string;
    onOpenUrl: (url: string) => void;
}) {
    const blocks = useMemo(() => parseMarkdownBlocks(source), [source]);
    if (blocks.length === 0) return null;
    return (
        <div className="mt-1 max-h-80 space-y-1.5 overflow-y-auto text-[12px] leading-5 wrap-anywhere text-muted">
            <MarkdownBlocks blocks={blocks} onOpenUrl={onOpenUrl} />
        </div>
    );
}
