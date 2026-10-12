import type { MarkdownDiagram } from '@caxri/markdown';
import type { ThemeTokens } from '@caxri/protocol';
import { delay, Semaphore } from 'es-toolkit';
import type Mermaid from 'mermaid';

import { MemoCache } from '../../lib/memo-cache';

/**
 * Rendered SVG keyed by the Mermaid theme seed and diagram source, so a keystroke elsewhere in the document does not
 * re-run Mermaid's layout for every diagram in it.
 */
const renderedDiagrams = new MemoCache<string>(48);
/**
 * Mermaid owns global theme and layout state, so mounted previews share a single layout permit.
 */
const diagramRenders = new Semaphore(1);

type MermaidModule = typeof Mermaid;

const state = {
    module: undefined as Promise<MermaidModule> | undefined,
    themeKey: undefined as string | undefined,
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

/**
 * Identity of the colors Mermaid is seeded with. Keyed on content rather than `theme.id` because editing a custom theme
 * keeps its id, and an id key would keep painting diagrams with the colors from before the edit.
 */
function mermaidThemeKey(theme: ThemeTokens): string {
    return JSON.stringify(mermaidThemeVariables(theme));
}

async function loadMermaid(theme: ThemeTokens, themeKey: string): Promise<MermaidModule> {
    state.module ??= importMermaid();
    const mermaid = await state.module;
    if (state.themeKey !== themeKey) {
        mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'base',
            themeVariables: mermaidThemeVariables(theme),
            fontFamily: 'inherit',
        });
        state.themeKey = themeKey;
        renderedDiagrams.clear();
    }
    return mermaid;
}

async function renderDiagram(
    element: HTMLElement,
    source: string,
    theme: ThemeTokens,
    signal: AbortSignal,
): Promise<void> {
    const themeKey = mermaidThemeKey(theme);
    const key = `${themeKey}\0${source}`;
    const cached = renderedDiagrams.get(key);
    if (cached !== undefined) {
        showDiagram(element, cached);
        return;
    }
    const mermaid = await loadMermaid(theme, themeKey);
    if (signal.aborted) return;
    state.sequence += 1;
    // Mermaid needs a document-unique id: it mounts a scratch copy of the diagram while measuring text.
    const { svg } = await mermaid.render(`caxri-mermaid-${state.sequence}`, source);
    renderedDiagrams.set(key, svg);
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the render above is awaited, so the signal can abort between the two checks; the narrowing is a false positive
    if (signal.aborted) return;
    showDiagram(element, svg);
}

/**
 * Marks a diagram whose source stopped parsing while it still shows the last version that did.
 */
const STALE_DIAGRAM_CLASS = 'is-stale';

function showDiagram(element: HTMLElement, svg: string): void {
    element.classList.remove(STALE_DIAGRAM_CLASS);
    element.innerHTML = svg;
}

/**
 * Renders one Mermaid source into `element`, or shows the parse or layout error (under the last good diagram, if any).
 *
 * Shared by the Markdown preview's `mermaid` fences and the `.mmd` / `.mermaid` file preview, so both take the same
 * theme seeding, render cache, layout permit, and error presentation.
 */
export async function renderMermaidDiagram(
    element: HTMLElement,
    source: string,
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
        await renderDiagram(element, source, theme, signal);
    } catch (error) {
        if (!signal.aborted) reportDiagramFailure(element, error);
    } finally {
        diagramRenders.release();
    }
}

/**
 * Shows a parse or layout error under the diagram.
 *
 * While the user types, nearly every keystroke between two valid states fails to parse. Replacing the diagram with the
 * error each time made the picture vanish and reappear on every edge being typed, so the last diagram that rendered
 * stays in place, dimmed, with the error below it. Only a diagram that never rendered shows the error alone.
 */
function reportDiagramFailure(element: HTMLElement, error: unknown): void {
    const hasLastGood = element.querySelector(':scope > svg') !== null;
    if (hasLastGood) element.querySelector(':scope > .caxri-markdown-diagram-error')?.remove();
    else element.replaceChildren();
    element.classList.toggle(STALE_DIAGRAM_CLASS, hasLastGood);
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
        renders.push(renderMermaidDiagram(element, diagram.source, theme, signal));
    }
    await Promise.all(renders);
}
