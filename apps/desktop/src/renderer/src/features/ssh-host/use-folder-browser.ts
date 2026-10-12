import { useState } from 'react';

import { useCaxriQuery } from '../../queries/client';
import { displayFolderPath, resolveFolderInput } from './folder-picker';

/**
 * Navigation state of the SSH Host folder picker. Listings go through the shared query cache, so stepping back into a
 * folder shows it at once; the previous listing stays on screen while the next one loads instead of collapsing the
 * list.
 */
export function useFolderBrowser() {
    /**
     * `undefined` asks the Server for its home folder, which is where the picker opens.
     */
    const [path, setPath] = useState<string>();
    const [input, setInput] = useState<string>();
    const [isInputInvalid, setIsInputInvalid] = useState(false);
    const listing = useCaxriQuery('project.browseFolders', path === undefined ? {} : { path }, {
        placeholderData: (previous) => previous,
        staleTime: 0,
    });
    const current = listing.data;
    const home = current?.home;

    function navigate(nextPath: string): void {
        setPath(nextPath);
        setInput(undefined);
        setIsInputInvalid(false);
    }

    function updateInput(value: string): void {
        setInput(value);
        setIsInputInvalid(false);
    }

    /**
     * Jumps to the typed folder, or flags the field when the text does not resolve to an absolute path.
     */
    function submitInput(): void {
        if (input === undefined || home === undefined) return;
        const resolved = resolveFolderInput(input, home);
        if (resolved) navigate(resolved);
        else setIsInputInvalid(true);
    }

    return {
        current,
        /**
         * The field shows the current folder until the user types; then it shows what they typed.
         */
        inputValue: input ?? (current ? displayFolderPath(current.path, current.home) : ''),
        isInputInvalid,
        isLoading: listing.isPending,
        isNavigating: listing.isFetching && listing.isPlaceholderData,
        loadError: listing.error,
        navigate,
        submitInput,
        updateInput,
    };
}
