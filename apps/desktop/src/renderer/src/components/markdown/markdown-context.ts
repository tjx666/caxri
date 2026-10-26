import type { ComponentType, ReactNode } from 'react';
import { createContext, useContext } from 'react';

/**
 * Draws diagram fences for a host that can. Supplied by the host rather than imported here, so hover cards never load
 * Mermaid and this shared renderer stays free of preview features.
 */
export interface MarkdownDiagramHost {
    /**
     * Renders `source` into `element`, or shows the parse error there; settles without throwing.
     */
    render(
        element: HTMLElement,
        source: string,
        signal: AbortSignal,
        options?: {
            /**
             * Lays the diagram out at its natural size for {@link MarkdownDiagramHost.ZoomFrame} to scale, instead of
             * shrinking it to the column.
             */
            isNatural?: boolean;
        },
    ): Promise<void>;
    /**
     * A zoomable, pannable frame around a diagram at its natural size, for the full-screen view.
     */
    ZoomFrame: ComponentType<{ children: ReactNode }>;
}

/**
 * Recognizes inline code that names a skill the host's Agent can use and draws it. Supplied by the host, as diagrams
 * are, so this shared renderer knows nothing about Agents.
 */
export interface MarkdownSkillHost {
    /**
     * The invocation (such as `$commit`) an inline code span names, or `undefined` when it names no known skill.
     */
    match(code: string): string | undefined;
    /**
     * Draws a matched span; `className` carries the renderer's inline code style.
     */
    Reference: ComponentType<{ className: string; code: string; invocation: string }>;
}

/**
 * Runs the commands a fenced block holds. Supplied by the host, as diagrams are, so this shared renderer knows nothing
 * about Terminals.
 */
export interface MarkdownCommandHost {
    /**
     * Whether a fence in this language holds commands the host can run.
     */
    canRun(language: string | undefined): boolean;
    run(command: string): void;
}

/**
 * Host-specific rendering choices and actions, shared by every block of one Markdown tree. Read through context so a
 * memoized block skips re-rendering on a streamed delta without each level threading the callbacks down.
 */
export interface MarkdownRenderContext {
    /**
     * `compact` keeps hover cards tight: one heading weight, bare code, no controls. `transcript` lays a Chat reply out
     * as a document: heading sizes, highlighted code with a header bar, task checkboxes, and copyable tables.
     */
    variant: 'compact' | 'transcript';
    onOpenUrl: (url: string) => void;
    /**
     * Opens a cited local file. Without it, file links and path-like code render as plain text.
     */
    onOpenFile?: (target: string) => void;
    /**
     * The Terminal GitHub lookups for links are routed through, so a pull request link can show its state.
     */
    referenceTerminalId?: string;
    /**
     * Draws `mermaid` fences as diagrams in the transcript variant. Without it they stay code.
     */
    diagrams?: MarkdownDiagramHost;
    /**
     * Adds a Run action to settled fences the host can execute. Without it, code blocks only copy.
     */
    commands?: MarkdownCommandHost;
    /**
     * Marks inline code that names a known skill. Without it, such code stays plain.
     */
    skills?: MarkdownSkillHost;
    /**
     * Set while the tree is a reply still streaming in: when (`performance.now()`) its renderer mounted. Text that
     * arrives after it fades in (`RevealingText`). Settled content leaves it unset and renders plain text.
     */
    revealSince?: number;
}

export const MarkdownContext = createContext<MarkdownRenderContext>({
    variant: 'compact',
    onOpenUrl: () => {},
});

export function useMarkdownContext(): MarkdownRenderContext {
    return useContext(MarkdownContext);
}
