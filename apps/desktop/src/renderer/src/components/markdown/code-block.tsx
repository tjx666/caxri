import type { MarkdownBlock } from '@caxri/markdown';

import { CodeView } from './code-view';
import { useMarkdownContext } from './markdown-context';

type CodeBlockNode = Extract<MarkdownBlock, { type: 'code' }>;

/**
 * A fenced block. Compact hosts show bare text. A transcript renders it as a `CodeView` labeled with the fence
 * language, painted with the editor's colors once the fence closes.
 */
export function CodeBlock({ block, isOpen }: { block: CodeBlockNode; isOpen: boolean }) {
    const { variant } = useMarkdownContext();
    if (variant === 'compact')
        return (
            <pre className="my-0 overflow-x-auto rounded bg-surface px-2 py-1 font-mono text-[11px] leading-4 text-foreground">
                {block.value}
            </pre>
        );
    return <CodeView code={block.value} isPaintable={!isOpen} language={block.language} />;
}
