import { useMemo } from 'react';

import type { MarkdownDiagramHost } from '../../../components/markdown/markdown-context';
import { useTheme } from '../../../stores/selectors';
import { renderMermaidDiagram, sizeDiagramNaturally } from '../../preview/markdown-diagrams';
import { AgentChatDiagramZoomFrame } from '../tools/agent-chat-diagram-zoom-frame';

/**
 * Mermaid lays text out at 16px; a Chat reply's prose is 14px. An inline diagram is drawn at that ratio of its natural
 * size so its labels read at the transcript's size instead of the column width deciding how large they get.
 */
const INLINE_DIAGRAM_SCALE = 14 / 16;

/**
 * Sizes an inline diagram from its viewBox rather than Mermaid's `width="100%"`, which stretched a small flowchart
 * across the whole column. `max-width: 100%` from the stylesheet still shrinks a wide one to fit.
 */
function sizeInlineDiagram(element: HTMLElement): void {
    const svg = element.querySelector<SVGSVGElement>(':scope > svg');
    const width = svg?.viewBox.baseVal.width;
    if (!svg || !width) return;
    svg.style.width = `${width * INLINE_DIAGRAM_SCALE}px`;
}

/**
 * Lets a Chat reply draw its `mermaid` fences through the Markdown preview's renderer, in the current theme's colors.
 * Undefined until the theme is known, so a fence stays code rather than rendering with the wrong colors.
 */
export function useAgentChatDiagrams(): MarkdownDiagramHost | undefined {
    const theme = useTheme();
    return useMemo(
        () =>
            theme && {
                render: async (element, source, signal, options) => {
                    await renderMermaidDiagram(element, source, theme, signal);
                    if (signal.aborted) return;
                    if (options?.isNatural) sizeDiagramNaturally(element);
                    else sizeInlineDiagram(element);
                },
                ZoomFrame: AgentChatDiagramZoomFrame,
            },
        [theme],
    );
}
