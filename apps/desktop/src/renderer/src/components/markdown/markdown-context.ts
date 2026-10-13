import { createContext, useContext } from 'react';

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
}

export const MarkdownContext = createContext<MarkdownRenderContext>({
    variant: 'compact',
    onOpenUrl: () => {},
});

export function useMarkdownContext(): MarkdownRenderContext {
    return useContext(MarkdownContext);
}
