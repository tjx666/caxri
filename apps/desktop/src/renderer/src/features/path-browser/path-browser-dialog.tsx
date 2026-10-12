import type { KeyboardEventHandler, RefObject } from 'react';

import { ChevronLeft, CornerDownLeft, FilePlus, FolderPlus } from 'lucide-react';

import { Dialog, DialogTitle, PickerDialogContent } from '../../components/ui/dialog';
import { Input, InputGroup } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { cn } from '../../lib/utilities';
import { setPathBrowserOpen, useDialogStore } from '../../stores/dialogs';
import { useIsRemote } from '../../stores/environment';
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
        goToParent,
        handleKeyDown,
        inputReference,
        isListboxRendered,
        isNavigating,
        isResultsReady,
        isStarting,
        listboxId,
        rows,
        input,
        mode,
        selectedRow,
        selectIndex,
        snapshot,
        updateInput,
    } = usePathBrowser(projectRoot, sessionId, workbenchProjectId);
    const { t } = useTranslation();
    const rootLabel = snapshot?.rootLabel ?? t('pathBrowser.projectRootFallback');
    const createDirectoryLabel = `${rootLabel}/${snapshot?.directoryLabel ?? ''}`;
    /**
     * Tab completes the typed path, which only a row of the listed directory can do. The list now mixes both lookups,
     * so the hint follows the highlighted row rather than a mode the whole list is in.
     */
    const isCompletable = selectedRow?.kind !== 'entry' || selectedRow.entry.source === 'directory';

    return (
        <PickerDialogContent className="w-[min(620px,calc(100vw-32px))]">
            <DialogTitle className="sr-only">{t('pathBrowser.dialog.title')}</DialogTitle>
            <PathBrowserQueryField
                activeOptionId={activeOptionId}
                directoryLabel={snapshot?.directoryLabel ?? ''}
                inputReference={inputReference}
                isListboxRendered={isListboxRendered}
                isParentDisabled={!snapshot?.canGoParent || isNavigating}
                isResultsReady={isResultsReady}
                listboxId={listboxId}
                mode={mode}
                rootLabel={rootLabel}
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
                />
                {isListboxRendered && !displayedError && (
                    <PathBrowserResults
                        createDirectoryLabel={createDirectoryLabel}
                        isFreeBrowsing={snapshot?.mode === 'free'}
                        listboxId={listboxId}
                        rows={rows}
                        selectedIndex={effectiveSelectedIndex}
                        onChoose={choose}
                        onCreate={() => runPathBrowserDetached(createFromQuery())}
                        onSelectIndex={selectIndex}
                    />
                )}
            </div>
            <PathBrowserHelp
                isCompletable={isCompletable}
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
    const { t } = useTranslation();
    const isProject = mode === 'project';
    /**
     * An SSH Host window has no free mode, so it does not advertise the `/` and `~` gestures that would leave the
     * Project.
     */
    const isRemote = useIsRemote();
    return (
        <InputGroup appearance="toolbar" size="palette">
            <button
                aria-label={t('pathBrowser.query.parentDirectory')}
                className="mr-1 grid size-7 flex-none place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                disabled={isParentDisabled}
                type="button"
                onClick={onGoToParent}
            >
                <ChevronLeft aria-hidden="true" size={16} />
            </button>
            {isProject ? (
                <>
                    <span className="flex-none text-[12px] text-muted">{rootLabel}/</span>
                    <span className="min-w-0 flex-none truncate text-[12px] text-muted">
                        {directoryLabel}
                    </span>
                </>
            ) : (
                /*
                 * Free mode used to have no chrome at all, so the absolute path had to live in the field to say where
                 * the browser was, and then had to be deleted before anything could be typed. It reads as a prefix
                 * here instead, on the same line and in the same muted tone the Project anchor uses.
                 *
                 * An absolute path's meaning is in its tail, so `path-ellipsis-start` drops the head when it overflows
                 * rather than the directory the user is standing in. It needs the inner element: see its rule in
                 * `styles.css`.
                 */
                <span
                    className="path-ellipsis-start max-w-[45%] min-w-0 flex-none overflow-hidden text-[12px] whitespace-nowrap text-muted"
                    title={directoryLabel}
                >
                    <span>{directoryLabel}</span>
                </span>
            )}
            <Input
                ref={inputReference}
                aria-activedescendant={activeOptionId}
                aria-autocomplete="list"
                aria-busy={!isResultsReady}
                aria-controls={isListboxRendered ? listboxId : undefined}
                aria-describedby={isRemote ? undefined : 'path-browser-project-anchor-help'}
                aria-expanded={isListboxRendered}
                aria-label={t('pathBrowser.query.inputLabel')}
                appearance="embedded"
                className="min-w-[80px] flex-1 px-1 text-foreground"
                placeholder={t(
                    isRemote
                        ? 'pathBrowser.query.placeholderRemote'
                        : isProject
                          ? 'pathBrowser.query.placeholderProject'
                          : 'pathBrowser.query.placeholderFree',
                )}
                role="combobox"
                size="palette"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={onKeyDown}
            />
            <span className="sr-only" id="path-browser-project-anchor-help">
                {t('pathBrowser.query.anchorHelp')}
            </span>
            <span aria-live="polite" className="sr-only">
                {isProject ? '' : t('pathBrowser.query.projectRootRemoved')}
            </span>
        </InputGroup>
    );
}

function PathBrowserResults({
    createDirectoryLabel,
    isFreeBrowsing,
    listboxId,
    rows,
    selectedIndex,
    onChoose,
    onCreate,
    onSelectIndex,
}: {
    createDirectoryLabel: string;
    isFreeBrowsing: boolean;
    listboxId: string;
    rows: readonly PathBrowserRow[];
    selectedIndex: number;
    onChoose: (entry: PathBrowserEntry) => void;
    onCreate: () => void;
    onSelectIndex: (index: number) => void;
}) {
    const { t } = useTranslation();
    return (
        <div aria-label={t('pathBrowser.results.label')} id={listboxId} role="listbox">
            {rows.map((row, index) => {
                // Hidden from assistive technology on purpose: each option repeats its group in its own name, which
                // is the only place the keyboard's `aria-activedescendant` will ever read it from.
                if (row.kind === 'group')
                    return (
                        <div
                            key={row.id}
                            aria-hidden="true"
                            className="px-2 pt-2 pb-1 text-[10px] font-bold tracking-[0.06em] text-muted uppercase"
                        >
                            {t(row.label)}
                        </div>
                    );
                // A notice is the answer to what the user typed, so it is announced when it appears rather than
                // waiting to be arrowed onto, which, being no option, it never would be.
                if (row.kind === 'notice')
                    return (
                        <p
                            key={row.id}
                            className={cn(
                                'm-0 px-2 py-1 text-[11px]',
                                row.tone === 'danger' ? 'text-danger' : 'text-muted',
                            )}
                            role="status"
                        >
                            {t(row.text)}
                        </p>
                    );
                return row.kind === 'create' ? (
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
                        groupLabel={row.group && t(row.group)}
                        isFreeBrowsing={isFreeBrowsing}
                        isSelected={index === selectedIndex}
                        onClick={() => onChoose(row.entry)}
                        onMouseMove={() => onSelectIndex(index)}
                    />
                );
            })}
        </div>
    );
}

/**
 * The list colours a row can wear, in the same `--list-*` roles the Files tree uses, so an imported theme reaches this
 * dialog too.
 *
 * Written as a choice rather than a hover utility plus an override because the hover fill has to be withheld from the
 * keyboard row: the pointer re-selects only when it moves, so a pointer left resting while the arrow keys walk away is
 * exactly when the two are different rows, and painting both would make both look current.
 *
 * A row that cannot be opened keeps its muted label through the hover. The fill still follows the pointer, but
 * recolouring the text would take away the one thing saying this row is refused, and a `hover:` utility outweighs the
 * plain `text-muted` the caller adds afterwards, so it has to be withheld here rather than overridden there.
 */
function rowStateClassName(isSelected: boolean, isDisabled = false): string {
    if (isSelected) return 'bg-list-focus-background text-list-focus-foreground';
    return isDisabled
        ? 'hover:bg-list-hover-background'
        : 'hover:bg-list-hover-background hover:text-list-hover-foreground';
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
    const { t } = useTranslation();
    const Icon = candidate.kind === 'directory' ? FolderPlus : FilePlus;
    return (
        <button
            id={id}
            aria-selected={isSelected}
            className={cn(
                'path-browser-create flex h-8 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground',
                rowStateClassName(isSelected),
            )}
            role="option"
            type="button"
            onClick={onClick}
            onMouseMove={onMouseMove}
        >
            <Icon aria-hidden="true" className="text-muted" size={14} />
            <span className="min-w-0 flex-1 truncate">
                {t(
                    candidate.kind === 'directory'
                        ? 'pathBrowser.results.createFolder'
                        : 'pathBrowser.results.createFile',
                    { name: candidate.name },
                )}
            </span>
            <span className="min-w-0 flex-none truncate text-[11px] text-muted">
                {t('pathBrowser.results.createDestination', { directory: directoryLabel })}
            </span>
        </button>
    );
}

function PathBrowserOption({
    entry,
    groupLabel,
    id,
    isFreeBrowsing,
    isSelected,
    onClick,
    onMouseMove,
}: {
    entry: PathBrowserEntry;
    groupLabel: string | undefined;
    id: string;
    isFreeBrowsing: boolean;
    isSelected: boolean;
    onClick: () => void;
    onMouseMove: () => void;
}) {
    const { t } = useTranslation();
    const isSymlink = entry.kind === 'symlink';
    const isDisabled = isSymlink && isFreeBrowsing;
    const description = isSymlink ? symlinkRowDescription(entry, t) : undefined;
    return (
        <button
            id={id}
            aria-describedby={isSymlink ? `${id}-reason` : undefined}
            aria-disabled={isDisabled}
            aria-selected={isSelected}
            className={cn(
                'flex h-8 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground',
                rowStateClassName(isSelected, isDisabled),
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
            {groupLabel && <span className="sr-only">{groupLabel}</span>}
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
                <CornerDownLeft
                    aria-label={t('pathBrowser.results.directory')}
                    className="text-muted"
                    size={13}
                />
            )}
        </button>
    );
}
