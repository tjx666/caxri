import type { KeyboardEvent, RefObject } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { FileEntry } from '@caxri/protocol';
import { projectRelativePath } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { resolveEntryKind } from '../../../lib/file-entry';
import { parentDirectoryPath } from '../../../lib/file-path';
import { useCaxriQuery } from '../../../queries/client';
import { tryCommand } from '../../../stores/toasts';
import type { EditorBreadcrumbSegment } from '../editor-breadcrumbs-model';
import {
    adjacentBreadcrumbPickerPath,
    editorBreadcrumbDirectoryLabel,
    editorBreadcrumbPickerDirectory,
    typeaheadBreadcrumbPickerPath,
} from '../editor-breadcrumbs-model';

const TYPEAHEAD_RESET_MS = 700;
const EMPTY_ENTRIES: FileEntry[] = [];

export interface EditorBreadcrumbPickerState {
    activeOptionId: string | undefined;
    activePath: string | undefined;
    currentDirectory: string;
    directoryLabel: string;
    entries: FileEntry[];
    error: Error | null;
    isError: boolean;
    isPending: boolean;
    listboxReference: RefObject<HTMLDivElement | null>;
    onEntryClick: (entry: FileEntry) => void;
    onEntryPointerMove: (entry: FileEntry) => void;
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    optionId: (index: number) => string;
    truncated: boolean;
}

export function useEditorBreadcrumbPicker({
    onOpenFile,
    projectRoot,
    segment,
    sessionId,
}: {
    onOpenFile: (path: string) => void;
    projectRoot: string;
    segment: EditorBreadcrumbSegment;
    sessionId: string;
}): EditorBreadcrumbPickerState {
    const { t } = useTranslation();
    const optionIdPrefix = useId();
    const listboxReference = useRef<HTMLDivElement>(null);
    const activation = useRef(0);
    const shouldScrollActiveOption = useRef(true);
    const typeaheadReference = useRef<{
        prefix: string;
        timer?: ReturnType<typeof setTimeout>;
    }>({ prefix: '' });
    const [currentDirectory, setCurrentDirectory] = useState(() =>
        editorBreadcrumbPickerDirectory(segment),
    );
    const [requestedActivePath, setRequestedActivePath] = useState<string | undefined>(
        segment.path,
    );
    const listing = useCaxriQuery('files.list', { sessionId, directory: currentDirectory });
    const entries = listing.data?.entries ?? EMPTY_ENTRIES;
    const directoryLabel = editorBreadcrumbDirectoryLabel(currentDirectory, projectRoot, t);
    const activePath = entries.some((entry) => entry.path === requestedActivePath)
        ? requestedActivePath
        : adjacentBreadcrumbPickerPath(entries, undefined, 'first');
    const activeIndex = entries.findIndex((entry) => entry.path === activePath);
    const activeOptionId = activeIndex === -1 ? undefined : `${optionIdPrefix}-${activeIndex}`;

    const requestActivePath = (path: string | undefined, shouldScrollIntoView = true): void => {
        shouldScrollActiveOption.current = shouldScrollIntoView;
        setRequestedActivePath(path);
    };

    const activateEntry = (entry: FileEntry): void => {
        const intent = ++activation.current;
        // eslint-disable-next-line no-void -- tryCommand owns error presentation
        void tryCommand(t('editor.breadcrumbs.openPathFailed'), async () => {
            const kind = await resolveEntryKind(sessionId, entry);
            if (intent !== activation.current) return;
            if (kind === 'directory') {
                setCurrentDirectory(entry.path);
                requestActivePath(undefined);
            } else onOpenFile(entry.path);
        });
    };

    useEffect(() => {
        if (!activeOptionId || !shouldScrollActiveOption.current) return;
        const option = listboxReference.current?.querySelector<HTMLElement>(
            `#${CSS.escape(activeOptionId)}`,
        );
        option?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);

    useEffect(
        () => () => {
            activation.current += 1;
            if (typeaheadReference.current.timer) clearTimeout(typeaheadReference.current.timer);
        },
        [],
    );

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        let nextPath: string | undefined;
        switch (event.key) {
            case 'ArrowDown': {
                nextPath = adjacentBreadcrumbPickerPath(entries, activePath, 'next');
                break;
            }
            case 'ArrowUp': {
                nextPath = adjacentBreadcrumbPickerPath(entries, activePath, 'previous');
                break;
            }
            case 'Home': {
                nextPath = adjacentBreadcrumbPickerPath(entries, activePath, 'first');
                break;
            }
            case 'End': {
                nextPath = adjacentBreadcrumbPickerPath(entries, activePath, 'last');
                break;
            }
            case 'ArrowLeft': {
                if (currentDirectory === projectRoot) return;
                const parent = parentDirectoryPath(currentDirectory);
                if (projectRelativePath(parent, projectRoot) === undefined) return;
                event.preventDefault();
                setCurrentDirectory(parent);
                activation.current += 1;
                requestActivePath(currentDirectory);
                return;
            }
            case 'ArrowRight':
            case 'Enter': {
                const entry = entries.find((candidate) => candidate.path === activePath);
                if (!entry) return;
                event.preventDefault();
                activateEntry(entry);
                return;
            }
            default: {
                if (
                    event.nativeEvent.isComposing ||
                    event.key.length !== 1 ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey
                )
                    return;
                const typeahead = typeaheadReference.current;
                if (typeahead.timer) clearTimeout(typeahead.timer);
                typeahead.prefix += event.key;
                typeahead.timer = setTimeout(() => {
                    typeahead.prefix = '';
                    typeahead.timer = undefined;
                }, TYPEAHEAD_RESET_MS);
                nextPath = typeaheadBreadcrumbPickerPath(entries, activePath, typeahead.prefix);
            }
        }
        if (!nextPath) return;
        event.preventDefault();
        requestActivePath(nextPath);
    };

    return {
        activeOptionId,
        activePath,
        currentDirectory,
        directoryLabel,
        entries,
        error: listing.error,
        isError: listing.isError,
        isPending: listing.isPending,
        listboxReference,
        onEntryClick: activateEntry,
        onEntryPointerMove: (entry) => {
            requestActivePath(entry.path, false);
        },
        onKeyDown,
        optionId: (index) => `${optionIdPrefix}-${index}`,
        truncated: listing.data?.truncated ?? false,
    };
}
