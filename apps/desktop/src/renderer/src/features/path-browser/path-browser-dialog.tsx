import { ChevronLeft, CornerDownLeft } from 'lucide-react';

import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { Input, InputGroup } from '../../components/ui/input';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { cn } from '../../lib/utilities';
import { setPathBrowserOpen, useDialogStore } from '../../stores/dialogs';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../stores/selectors';
import { symlinkRowDescription } from '../view-containers/resource-explorer/resource-explorer-state';
import { PathBrowserHelp, PathBrowserStatus } from './path-browser-status';
import type { PathBrowserEntry } from './use-path-browser';
import { usePathBrowser } from './use-path-browser';

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
        candidateToCreate,
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
        matches,
        input,
        mode,
        selectIndex,
        snapshot,
        updateInput,
    } = usePathBrowser(projectRoot, sessionId, workbenchProjectId);

    return (
        <PickerDialogContent className="w-[min(620px,calc(100vw-32px))]">
            <DialogTitle className="sr-only">Open File by Path</DialogTitle>
            <InputGroup appearance="toolbar" size="palette">
                <button
                    aria-label="Parent directory"
                    className="mr-1 grid size-7 flex-none place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                    disabled={!snapshot?.canGoParent || isNavigating}
                    type="button"
                    onClick={goToParent}
                >
                    <ChevronLeft aria-hidden="true" size={16} />
                </button>
                {mode === 'project' && (
                    <>
                        <span className="flex-none text-[12px] text-muted">
                            {snapshot?.rootLabel ?? 'Project'}/
                        </span>
                        <span className="min-w-0 flex-none truncate text-[12px] text-muted">
                            {snapshot?.directoryLabel ?? ''}
                        </span>
                    </>
                )}
                <Input
                    ref={inputReference}
                    aria-activedescendant={activeOptionId}
                    aria-autocomplete="list"
                    aria-busy={!isResultsReady}
                    aria-controls={isListboxRendered ? listboxId : undefined}
                    aria-describedby={
                        mode === 'project' ? 'path-browser-project-anchor-help' : undefined
                    }
                    aria-expanded={isListboxRendered}
                    aria-label="File path"
                    appearance="embedded"
                    className="min-w-[80px] flex-1 px-1 text-foreground"
                    placeholder={
                        mode === 'project'
                            ? 'Filter or enter a relative path…'
                            : 'Enter ~/…, ../…, or /absolute/path…'
                    }
                    role="combobox"
                    size="palette"
                    value={input}
                    onChange={(event) => updateInput(event.target.value)}
                    onKeyDown={handleKeyDown}
                />
                <span className="sr-only" id="path-browser-project-anchor-help">
                    At the start of an empty field, press Backspace or Delete to remove the Project
                    root and browse any path.
                </span>
                <span aria-live="polite" className="sr-only">
                    {mode === 'free' ? 'Project root removed. Enter any path.' : ''}
                </span>
            </InputGroup>
            <div className="max-h-[360px] min-h-[180px] overflow-auto p-1">
                <PathBrowserStatus
                    isStarting={isStarting}
                    isNavigating={isNavigating}
                    displayedError={displayedError}
                    isResultsReady={isResultsReady}
                    emptyMessage={emptyMessage}
                    candidateToCreate={candidateToCreate}
                    createFromQuery={createFromQuery}
                />
                {isListboxRendered && !displayedError && (
                    <div aria-label="Files in current directory" id={listboxId} role="listbox">
                        {matches.map((entry, index) => (
                            <PathBrowserOption
                                key={entry.id}
                                id={`${listboxId}-option-${index}`}
                                entry={entry}
                                isFreeBrowsing={snapshot?.mode === 'free'}
                                isSelected={index === effectiveSelectedIndex}
                                onClick={() => choose(entry)}
                                onMouseMove={() => selectIndex(index)}
                            />
                        ))}
                    </div>
                )}
                {isListboxRendered && isTruncated && matches.length > 0 && (
                    <p className="px-2 py-1 text-[10px] text-muted" role="status">
                        Only part of this directory is shown. Refine or open a narrower folder.
                    </p>
                )}
            </div>
            <PathBrowserHelp
                hasCreationCandidate={Boolean(candidateToCreate)}
                isProject={mode === 'project'}
            />
        </PickerDialogContent>
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
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
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
