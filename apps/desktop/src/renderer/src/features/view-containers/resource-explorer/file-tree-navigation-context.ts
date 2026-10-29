import { createContext, useContext } from 'react';

import type { FileTreeNavigation } from './file-tree-rows';

export interface FileTreeNavigator {
    /**
     * Moves keyboard focus from the row at `path` through the flattened model, scrolling the target into view first so
     * a row outside the virtualized window mounts and then takes the focus request.
     */
    move: (path: string, action: FileTreeNavigation) => void;
    /**
     * Path of the entry row `action` resolves to from `path`, without moving focus; `undefined` when there is none.
     */
    pathFor: (path: string, action: FileTreeNavigation) => string | undefined;
}

const noop: FileTreeNavigator = { move: () => {}, pathFor: () => {} };

/**
 * Hands rows the tree-level navigator without threading it through props: the tree owns the flattened model and the
 * virtualizer, and a stable context value keeps memoized rows from re-rendering when either changes.
 */
export const FileTreeNavigationContext = createContext<FileTreeNavigator>(noop);

export function useFileTreeNavigator(): FileTreeNavigator {
    return useContext(FileTreeNavigationContext);
}
