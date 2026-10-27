import type { MarkdownBlock } from '@caxri/markdown';

import { CodeView } from './code-view';
import { DiagramBlock } from './diagram-block';
import { useMarkdownContext } from './markdown-context';

type CodeBlockNode = Extract<MarkdownBlock, { type: 'code' }>;

/**
 * A fenced block. Compact hosts show bare text. A transcript renders it as a `CodeView` labeled with the fence
 * language, painted with the editor's colors once the fence closes; a closed `mermaid` fence becomes a diagram when the
 * host draws them. A closed fence the host can execute (`MarkdownCommandHost`) also offers Run; a fence still streaming
 * never does, so a half-written command cannot be started. A long block folds to its first lines, so it does not push
 * the rest of the reply far below.
 */
export function CodeBlock({ block, isOpen }: { block: CodeBlockNode; isOpen: boolean }) {
    const { commands, diagrams, variant } = useMarkdownContext();
    if (diagrams && !isOpen && block.language?.trim().toLowerCase() === 'mermaid')
        return <DiagramBlock diagrams={diagrams} source={block.value} />;
    if (variant === 'compact')
        return (
            <pre className="my-0 overflow-x-auto rounded bg-surface px-2 py-1 font-mono text-[11px] leading-4 text-foreground">
                {block.value}
            </pre>
        );
    return (
        <CodeView
            code={block.value}
            isCollapsible
            isPaintable={!isOpen}
            language={block.language}
            onRun={
                commands && !isOpen && commands.canRun(block.language)
                    ? () => commands.run(block.value)
                    : undefined
            }
        />
    );
}
