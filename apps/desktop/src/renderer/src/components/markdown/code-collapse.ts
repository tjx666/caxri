import type { RefObject } from 'react';
import { useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * How many lines a collapsed code block still shows. Linear's documents cut a long block to about fifteen lines.
 */
export const COLLAPSED_CODE_LINES = 15;

/**
 * A block collapses only when it hides more than a few lines: folding 17 lines behind a button to show 15 saves less
 * room than the button costs.
 */
const COLLAPSE_MIN_LINES = 21;

/**
 * Lines as the reader sees them: a trailing newline closes the last line rather than opening an empty one.
 */
export function countCodeLines(code: string): number {
    if (code === '') return 0;
    let count = 1;
    for (const character of code) if (character === '\n') count += 1;
    return code.endsWith('\n') ? count - 1 : count;
}

export function isCodeCollapsible(lineCount: number): boolean {
    return lineCount >= COLLAPSE_MIN_LINES;
}

export interface CodeCollapse {
    isExpanded: boolean;
    lineCount: number;
    toggle: () => void;
}

/**
 * Fold state for one code block, or no state when the block is short enough to stay whole. Collapsing a block the
 * reader scrolled through brings its top back into view: the fold removes everything below the first lines, and without
 * the scroll the reader would land on whatever followed the block.
 */
export function useCodeCollapse(
    code: string,
    isEnabled: boolean,
): { collapse: CodeCollapse | undefined; frameReference: RefObject<HTMLDivElement | null> } {
    const frameReference = useRef<HTMLDivElement>(null);
    const [isExpanded, setExpanded] = useState(false);
    const lineCount = useMemo(() => countCodeLines(code), [code]);
    const isCollapsible = isEnabled && isCodeCollapsible(lineCount);
    const collapse = useMemo(
        () =>
            isCollapsible
                ? {
                      isExpanded,
                      lineCount,
                      toggle: () => {
                          if (!isExpanded) {
                              setExpanded(true);
                              return;
                          }
                          // Commit the fold first so the scroll measures the collapsed block, not the expanded one.
                          flushSync(() => setExpanded(false));
                          frameReference.current?.scrollIntoView({ block: 'nearest' });
                      },
                  }
                : undefined,
        [isCollapsible, isExpanded, lineCount],
    );
    return { collapse, frameReference };
}
