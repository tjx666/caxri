import type { KeyboardEvent } from 'react';
import { useState } from 'react';

import { useCaxriQuery } from '../../queries/client';
import { filterPathEntries, parsePathBrowserInput } from '../path-browser/path-browser';
import {
    folderInputText,
    folderInputView,
    folderKeyAction,
    folderTargetIndex,
    moveFolderSelection,
    resolveFolderInput,
} from './folder-picker';

/**
 * Navigation state of the SSH Host folder picker. Listings go through the shared query cache, so stepping back into a
 * folder shows it at once; the previous listing stays on screen while the next one loads instead of collapsing the
 * list.
 *
 * The field is a path whose last segment filters the listed folders, as in Open File by Path. Typing a slash lists the
 * folder before it; the key meanings come from Path browser's key table (`folderKeyAction`).
 */
export function useFolderBrowser() {
    /**
     * `undefined` asks the Server for its home folder, which is where the picker opens.
     */
    const [path, setPath] = useState<string>();
    const [input, setInput] = useState<string>();
    const [isInputInvalid, setIsInputInvalid] = useState(false);
    /**
     * The row the arrow keys or the pointer chose, as an index into the filtered folders.
     */
    const [selectedIndex, setSelectedIndex] = useState<number>();
    const listing = useCaxriQuery('project.browseFolders', path === undefined ? {} : { path }, {
        placeholderData: (previous) => previous,
        staleTime: 0,
    });
    const current = listing.data;
    const home = current?.home;
    const inputValue = input ?? (current ? folderInputText(current.path, current.home) : '');
    const filter = home === undefined ? '' : folderInputView(inputValue, home).filter;
    const entries = current ? filterPathEntries(current.entries, filter) : undefined;
    const targetIndex = entries ? folderTargetIndex(entries, filter, selectedIndex) : undefined;

    function navigate(nextPath: string): void {
        setPath(nextPath);
        setInput(undefined);
        setIsInputInvalid(false);
        setSelectedIndex(undefined);
    }

    /**
     * Lists the folder the text names as soon as it names a different one, so the rows being filtered are the ones the
     * user is typing into.
     */
    function updateInput(value: string): void {
        setInput(value);
        setIsInputInvalid(false);
        setSelectedIndex(undefined);
        if (home === undefined) return;
        const { directory } = folderInputView(value, home);
        if (directory !== undefined && directory !== (path ?? current?.path)) setPath(directory);
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

    /**
     * Completes the field to the target folder, keeping the form the user typed (`~/` or absolute).
     */
    function completeInput(): void {
        const target = targetIndex === undefined ? undefined : entries?.[targetIndex];
        if (!target) return;
        let directoryPart: string;
        try {
            directoryPart = parsePathBrowserInput(inputValue).directoryPart;
        } catch {
            return;
        }
        updateInput(`${directoryPart}${target.name}/`);
    }

    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
        const action = folderKeyAction({
            entryCount: entries?.length ?? 0,
            hasTarget: targetIndex !== undefined,
            input: inputValue,
            isComposing: event.nativeEvent.isComposing,
            key: event.key,
            selectionEnd: event.currentTarget.selectionEnd,
            selectionStart: event.currentTarget.selectionStart,
        });
        if (!action) return;
        event.preventDefault();
        const target = targetIndex === undefined ? undefined : entries?.[targetIndex];
        switch (action.kind) {
            case 'move': {
                setSelectedIndex(
                    moveFolderSelection(entries?.length ?? 0, selectedIndex, action.delta),
                );
                return;
            }
            case 'complete': {
                completeInput();
                return;
            }
            case 'open-target': {
                if (target) navigate(target.path);
                return;
            }
            case 'parent': {
                if (current?.parent) navigate(current.parent);
                return;
            }
            case 'submit-path': {
                submitInput();
            }
        }
    }

    return {
        current,
        entries,
        handleKeyDown,
        /**
         * The field shows the current folder until the user types; then it shows what they typed.
         */
        inputValue,
        isInputInvalid,
        isLoading: listing.isPending,
        isNavigating: listing.isFetching && listing.isPlaceholderData,
        loadError: listing.error,
        navigate,
        selectIndex: setSelectedIndex,
        targetIndex,
        updateInput,
    };
}
