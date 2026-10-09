import type { MarkdownDiagram } from '@caxri/markdown';
import type { ThemeTokens } from '@caxri/protocol';
import { delay, Semaphore } from 'es-toolkit';
import type Mermaid from 'mermaid';

import { MemoCache } from '../../lib/memo-cache';

/**
 * Rendered SVG keyed by theme and diagram source, so a keystroke elsewhere in the document does not re-run Mermaid's
 * layout for every diagram in it.
 */
const renderedDiagrams = new MemoCache<string>(48);
/**
 * Mermaid owns global theme and layout state, so mounted previews share a single layout permit.
 */
const diagramRenders = new Semaphore(1);

type MermaidModule = typeof Mermaid;

const state = {
    module: undefined as Promise<MermaidModule> | undefined,
    themeId: undefined as string | undefined,
    sequence: 0,
};

/**
 * Translates Caxri's semantic tokens into Mermaid's theme variables.
 *
 * Mermaid derives most of its palette from a handful of seeds, so the mapping stays deliberately small: the canvas, the
 * node fill and its text, the connecting lines, and the borders. Anything richer drifts out of sync the moment a theme
 * moves one of the roles it was derived from.
 */
function mermaidThemeVariables(theme: ThemeTokens): Record<string, string> {
    return {
        background: theme.editor.background,
        primaryColor: theme.colors.elevated,
        primaryTextColor: theme.colors.foreground,
        primaryBorderColor: theme.colors.border,
        secondaryColor: theme.colors.surface,
        tertiaryColor: theme.colors.background,
        lineColor: theme.colors.muted,
        textColor: theme.colors.foreground,
        mainBkg: theme.colors.elevated,
        nodeBorder: theme.colors.border,
        clusterBkg: theme.colors.surface,
        clusterBorder: theme.colors.border,
        titleColor: theme.colors.foreground,
        edgeLabelBackground: theme.colors.surface,
        errorBkgColor: theme.colors.danger,
        errorTextColor: theme.colors.background,
    };
}

/**
 * Loads Mermaid on first use and re-seeds it whenever the active theme changes.
 *
 * The import is dynamic because Mermaid is by far the heaviest thing a preview can pull in, and a document without a
 * `mermaid` fence must never pay for it. `startOnLoad: false` keeps it from scanning the workbench DOM, and the strict
 * security level keeps diagram labels from smuggling markup back in.
 */
async function importMermaid(): Promise<MermaidModule> {
    const module = await import('mermaid');
    return module.default;
}

async function loadMermaid(theme: ThemeTokens): Promise<MermaidModule> {
    state.module ??= importMermaid();
    const mermaid = await state.module;
    if (state.themeId !== theme.id) {
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'base',
            themeVariables: mermaidThemeVariables(theme),
            fontFamily: 'inherit',
        });
        state.themeId = theme.id;
        renderedDiagrams.clear();
    }
    return mermaid;
}

async function renderDiagram(
    element: HTMLElement,
    diagram: MarkdownDiagram,
    theme: ThemeTokens,
    signal: AbortSignal,
): Promise<void> {
    const key = `${theme.id}\0${diagram.source}`;
    const cached = renderedDiagrams.get(key);
    if (cached !== undefined) {
        element.innerHTML = cached;
        return;
    }
    const mermaid = await loadMermaid(theme);
    if (signal.aborted) return;
    state.sequence += 1;
    // Mermaid needs a document-unique id: it mounts a scratch copy of the diagram while measuring text.
    const { svg } = await mermaid.render(`caxri-mermaid-${state.sequence}`, diagram.source);
    renderedDiagrams.set(key, svg);
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the render above is awaited, so the signal can abort between the two checks; the narrowing is a false positive
    if (signal.aborted) return;
    element.innerHTML = svg;
}

async function renderDiagramReportingFailure(
    element: HTMLElement,
    diagram: MarkdownDiagram,
    theme: ThemeTokens,
    signal: AbortSignal,
): Promise<void> {
    await diagramRenders.acquire();
    try {
        if (signal.aborted) return;
        /**
         * A task boundary lets scrolling, input, and tab changes run between synchronous Mermaid layouts.
         */
        await delay(0, { signal });
        await renderDiagram(element, diagram, theme, signal);
    } catch (error) {
        if (!signal.aborted) reportDiagramFailure(element, error);
    } finally {
        diagramRenders.release();
    }
}

function reportDiagramFailure(element: HTMLElement, error: unknown): void {
    element.replaceChildren();
    const message = element.ownerDocument.createElement('p');
    message.className = 'caxri-markdown-diagram-error';
    message.textContent =
        error instanceof Error ? error.message : 'This diagram could not be rendered.';
    element.append(message);
}

/**
 * Renders every `mermaid` fence the document declared. A diagram that fails to parse shows its own error in place, the
 * way an editing preview should: the rest of the document keeps rendering.
 */
export async function renderDiagrams(
    container: HTMLElement,
    diagrams: readonly MarkdownDiagram[],
    theme: ThemeTokens,
    signal: AbortSignal,
): Promise<void> {
    const renders: Array<Promise<void>> = [];
    for (const diagram of diagrams) {
        const element = container.querySelector(`[data-caxri-diagram="${CSS.escape(diagram.id)}"]`);
        if (!(element instanceof HTMLElement)) continue;
        renders.push(renderDiagramReportingFailure(element, diagram, theme, signal));
    }
    await Promise.all(renders);
}
