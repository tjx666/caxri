import { useEffect, useId, useRef } from 'react';

import { Workflow } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { textClipboard } from '../../lib/clipboard';
import { writeToClipboardWithFeedback } from '../copy-feedback';
import { BlockFullscreenButton, BlockFullscreenDialog } from './block-fullscreen-dialog';
import { CopyIconButton } from './copy-icon-button';
import type { MarkdownDiagramHost } from './markdown-context';
import { useBlockFullscreen } from './use-block-fullscreen';

function Diagram({
    className,
    diagrams,
    isNatural = false,
    label,
    source,
}: {
    className?: string;
    diagrams: MarkdownDiagramHost;
    isNatural?: boolean;
    label: string;
    source: string;
}) {
    const reference = useRef<HTMLElement>(null);
    useEffect(() => {
        const element = reference.current;
        if (!element) return;
        const controller = new AbortController();
        void diagrams.render(element, source, controller.signal, { isNatural });
        return () => controller.abort();
    }, [diagrams, isNatural, source]);
    // A figure rather than an image: the parse error rendered inside it has to stay readable.
    return <figure aria-label={label} className={className} ref={reference} />;
}

/**
 * A closed `mermaid` fence in a Chat reply, drawn as the diagram it describes, as the Markdown preview draws it. It
 * keeps a code block's frame: a header naming it, then Copy (the source) and View Full Screen revealed on hover or
 * focus, over the diagram fitted to the column. Full screen opens it at its natural size in a zoomable, pannable frame.
 * A source that does not parse shows the parser's error in place of the picture.
 */
export function DiagramBlock({
    diagrams,
    source,
}: {
    diagrams: MarkdownDiagramHost;
    source: string;
}) {
    const { t } = useTranslation();
    const fullscreen = useBlockFullscreen();
    const title = t('core.block.diagram');
    const copy = (
        <CopyIconButton
            copy={() => writeToClipboardWithFeedback(textClipboard, source)}
            label={t('core.copy.diagramSource')}
        />
    );
    const { ZoomFrame } = diagrams;
    const labelId = useId();
    return (
        <div
            aria-labelledby={labelId}
            className="group/diagram overflow-hidden rounded-lg bg-elevated"
            role="group"
        >
            <div className="flex h-8 items-center gap-1.5 pt-1 pr-1.5 pl-3 text-[12px] text-muted select-none">
                <Workflow aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate" id={labelId}>
                    {title}
                </span>
                <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-(--motion-feedback) group-focus-within/diagram:opacity-100 group-hover/diagram:opacity-100">
                    {copy}
                    <BlockFullscreenButton onOpen={fullscreen.open} />
                </div>
            </div>
            <Diagram
                className="caxri-markdown-diagram caxri-chat-diagram m-0"
                diagrams={diagrams}
                label={title}
                source={source}
            />
            <BlockFullscreenDialog
                actions={copy}
                bodyClassName="flex flex-col bg-background"
                isOpen={fullscreen.isOpen}
                title={title}
                onOpenChange={fullscreen.setOpen}
            >
                <ZoomFrame>
                    <Diagram
                        className="caxri-markdown-diagram caxri-mermaid-file-diagram m-0"
                        diagrams={diagrams}
                        isNatural
                        label={title}
                        source={source}
                    />
                </ZoomFrame>
            </BlockFullscreenDialog>
        </div>
    );
}
