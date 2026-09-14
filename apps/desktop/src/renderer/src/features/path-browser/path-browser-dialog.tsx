import type { KeyboardEventHandler, RefObject } from 'react';

import { ChevronLeft, CornerDownLeft, FilePlus, FolderPlus } from 'lucide-react';

import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { Input, InputGroup } from '../../components/ui/input';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { cn } from '../../lib/utilities';
import { setPathBrowserOpen, useDialogStore } from '../../stores/dialogs';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../stores/selectors';
import { symlinkRowDescription } from '../view-containers/resource-explorer/resource-explorer-state';
import type { PathBrowserCreateCandidate, PathBrowserMode } from './path-browser';
import { PathBrowserHelp, PathBrowserStatus } from './path-browser-status';
import type { PathBrowserEntry, PathBrowserRow } from './use-path-browser';
import { runPathBrowserDetached, usePathBrowser } from './use-path-browser';

export function PathBrowserDialog() {
    const isOpen = useDialogStore((state) => state.pathBrowserOpen);
    const project = useSelectedWorkbenchProject();
    const session = useSelectedSession();
    return (
        <Dialog open={isOpen} onOpenChange={setPathBrowserOpen}>
            {isOpen && project && session && (
                <PathBrowserContent
                    key={`${session.id}:${project.id}`}
                    projectRoot={project.rootPath}
                    sessionId={session.id}
                    workbenchProjectId={project.id}
                />
            )}
        </Dialog>
    );
}

function PathBrowserContent({
    projectRoot,
    sessionId,
    workbenchProjectId,
}: {
    projectRoot: string;
    sessionId: string;
    workbenchProjectId: string;
}) {
    const {
        activeOptionId,
        choose,
        createFromQuery,
        displayedError,
        effectiveSelectedIndex,
        emptyMessage,
        goToParent,
        handleKeyDown,
        inputReference,
        isListboxRendered,
        isNavigating,
        isResultsReady,
        isStarting,
        isTruncated,
        listboxId,
        resultKind,
        rows,
        input,
        mode,
        selectedRow,
        selectIndex,
        snapshot,
        updateInput,
    } = usePathBrowser(projectRoot, sessionId, workbenchProjectId);
    const createDirectoryLabel = `${snapshot?.rootLabel ?? 'Project'}/${snapshot?.directoryLabel ?? ''}`;
    const isProjectSearch = resultKind === 'projectSearch';

    return (
        <PickerDialogContent className="w-[min(620px,calc(100vw-32px))]">
            <DialogTitle className="sr-only">Open File by Path</DialogTitle>
            <PathBrowserQueryField
                activeOptionId={activeOptionId}
                directoryLabel={snapshot?.directoryLabel ?? ''}
                inputReference={inputReference}
                isListboxRendered={isListboxRendered}
                isParentDisabled={!snapshot?.canGoParent || isNavigating}
                isResultsReady={isResultsReady}
                listboxId={listboxId}
                mode={mode}
                rootLabel={snapshot?.rootLabel ?? 'Project'}
                value={input}
                onChange={updateInput}
                onGoToParent={goToParent}
                onKeyDown={handleKeyDown}
            />
            <div className="max-h-[360px] min-h-[180px] overflow-auto p-1">
                <PathBrowserStatus
                    isStarting={isStarting}
                    isNavigating={isNavigating}
                    displayedError={displayedError}
                    isResultsReady={isResultsReady}
                    emptyMessage={emptyMessage}
                />
                {isListboxRendered && !displayedError && (
                    <PathBrowserResults
                        createDirectoryLabel={createDirectoryLabel}
                        isFreeBrowsing={snapshot?.mode === 'free'}
                        isProjectSearch={isProjectSearch}
                        listboxId={listboxId}
                        rows={rows}
                        selectedIndex={effectiveSelectedIndex}
                        onChoose={choose}
                        onCreate={() => runPathBrowserDetached(createFromQuery())}
                        onSelectIndex={selectIndex}
                    />
                )}
                {isListboxRendered && isTruncated && rows.length > 0 && (
                    <p className="px-2 py-1 text-[10px] text-muted" role="status">
                        {isProjectSearch
                            ? 'Only part of this Project was searched. Refine the name.'
                            : 'Only part of this directory is shown. Refine or open a narrower folder.'}
                    </p>
                )}
            </div>
            <PathBrowserHelp
                isCompletable={!isProjectSearch}
                isCreateSelected={selectedRow?.kind === 'create'}
                isProject={mode === 'project'}
            />
        </PickerDialogContent>
    );
}

function PathBrowserQueryField({
    activeOptionId,
    directoryLabel,
    inputReference,
    isListboxRendered,
    isParentDisabled,
    isResultsReady,
    listboxId,
    mode,
    rootLabel,
    value,
    onChange,
    onGoToParent,
    onKeyDown,
}: {
    activeOptionId: string | undefined;
    directoryLabel: string;
    inputReference: RefObject<HTMLInputElement | null>;
    isListboxRendered: boolean;
    isParentDisabled: boolean;
    isResultsReady: boolean;
    listboxId: string;
    mode: PathBrowserMode;
    rootLabel: string;
    value: string;
    onChange: (value: string) => void;
    onGoToParent: () => void;
    onKeyDown: KeyboardEventHandler<HTMLInputElement>;
}) {
    const isProject = mode === 'project';
    return (
        <InputGroup appearance="toolbar" size="palette">
            <button
                aria-label="Parent directory"
                className="mr-1 grid size-7 flex-none place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                disabled={isParentDisabled}
                type="button"
                onClick={onGoToParent}
            >
                <ChevronLeft aria-hidden="true" size={16} />
            </button>
            {isProject && (
                <>
                    <span className="flex-none text-[12px] text-muted">{rootLabel}/</span>
                    <span className="min-w-0 flex-none truncate text-[12px] text-muted">
                        {directoryLabel}
                    </span>
                </>
            )}
            <Input
                ref={inputReference}
                aria-activedescendant={activeOptionId}
                aria-autocomplete="list"
                aria-busy={!isResultsReady}
                aria-controls={isListboxRendered ? listboxId : undefined}
                aria-describedby={isProject ? 'path-browser-project-anchor-help' : undefined}
                aria-expanded={isListboxRendered}
                aria-label="File path"
                appearance="embedded"
                className="min-w-[80px] flex-1 px-1 text-foreground"
                placeholder={
                    isProject
                        ? 'Filter or enter a relative path…'
                        : 'Enter ~/…, ../…, or /absolute/path…'
                }
                role="combobox"
                size="palette"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={onKeyDown}
            />
            <span className="sr-only" id="path-browser-project-anchor-help">
                At the start of an empty field, press Backspace or Delete to remove the Project root
                and browse any path.
            </span>
            <span aria-live="polite" className="sr-only">
                {isProject ? '' : 'Project root removed. Enter any path.'}
            </span>
        </InputGroup>
    );
}

function PathBrowserResults({
    createDirectoryLabel,
    isFreeBrowsing,
    isProjectSearch,
    listboxId,
    rows,
    selectedIndex,
    onChoose,
    onCreate,
    onSelectIndex,
}: {
    createDirectoryLabel: string;
    isFreeBrowsing: boolean;
    isProjectSearch: boolean;
    listboxId: string;
    rows: readonly PathBrowserRow[];
    selectedIndex: number;
    onChoose: (entry: PathBrowserEntry) => void;
    onCreate: () => void;
    onSelectIndex: (index: number) => void;
}) {
    return (
        <div
            aria-label={isProjectSearch ? 'Files in this Project' : 'Files in current directory'}
            id={listboxId}
            role="listbox"
        >
            {rows.map((row, index) =>
                row.kind === 'create' ? (
                    <PathBrowserCreateOption
                        key="create"
                        id={`${listboxId}-option-${index}`}
                        candidate={row.candidate}
                        directoryLabel={createDirectoryLabel}
                        isSelected={index === selectedIndex}
                        onClick={onCreate}
                        onMouseMove={() => onSelectIndex(index)}
                    />
                ) : (
                    <PathBrowserOption
                        key={row.entry.id}
                        id={`${listboxId}-option-${index}`}
                        entry={row.entry}
                        isFreeBrowsing={isFreeBrowsing}
                        isSelected={index === selectedIndex}
                        onClick={() => onChoose(row.entry)}
                        onMouseMove={() => onSelectIndex(index)}
                    />
                ),
            )}
        </div>
    );
}

/**
 * Creation targets the browser's current directory while neighbouring `projectSearch` rows come from anywhere in the
 * Project, so this row names its destination rather than relying on the header breadcrumb.
 */
function PathBrowserCreateOption({
    candidate,
    directoryLabel,
    id,
    isSelected,
    onClick,
    onMouseMove,
}: {
    candidate: PathBrowserCreateCandidate;
    directoryLabel: string;
    id: string;
    isSelected: boolean;
    onClick: () => void;
    onMouseMove: () => void;
}) {
    const Icon = candidate.kind === 'directory' ? FolderPlus : FilePlus;
    return (
        <button
            id={id}
            aria-selected={isSelected}
            className={cn(
                'path-browser-create flex h-8 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground hover:bg-elevated',
                isSelected && 'bg-elevated',
            )}
            role="option"
            type="button"
            onClick={onClick}
            onMouseMove={onMouseMove}
        >
            <Icon aria-hidden="true" className="text-muted" size={14} />
            <span className="min-w-0 flex-1 truncate">
                Create {candidate.kind === 'directory' ? 'folder' : 'file'} “{candidate.name}”
            </span>
            <span className="min-w-0 flex-none truncate text-[11px] text-muted">
                in {directoryLabel}
            </span>
        </button>
    );
}

function PathBrowserOption({
    entry,
    id,
    isFreeBrowsing,
    isSelected,
    onClick,
    onMouseMove,
}: {
    entry: PathBrowserEntry;
    id: string;
    isFreeBrowsing: boolean;
    isSelected: boolean;
    onClick: () => void;
    onMouseMove: () => void;
}) {
    const isSymlink = entry.kind === 'symlink';
    const isDisabled = isSymlink && isFreeBrowsing;
    const description = isSymlink ? symlinkRowDescription(entry) : undefined;
    return (
        <button
            id={id}
            aria-describedby={isSymlink ? `${id}-reason` : undefined}
            aria-disabled={isDisabled}
            aria-selected={isSelected}
            className={cn(
                'flex h-8 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground hover:bg-elevated',
                isSelected && 'bg-elevated',
                isDisabled && 'cursor-not-allowed text-muted',
            )}
            role="option"
            type="button"
            disabled={isDisabled}
            title={description}
            onClick={onClick}
            onMouseMove={onMouseMove}
        >
            <FileTypeIcon entry={entry} />
            <span className="min-w-0 shrink truncate">{entry.name}</span>
            {/* `flex-1` with a zero basis makes the Project-relative directory give up width before the file name does. */}
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
                {entry.directoryLabel ?? ''}
            </span>
            {isSymlink && (
                <span id={`${id}-reason`} className="sr-only">
                    {description}
                </span>
            )}
            {entry.kind === 'directory' && (
                <CornerDownLeft aria-label="Directory" className="text-muted" size={13} />
            )}
        </button>
    );
}
