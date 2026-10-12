import type { MethodResult } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import { ArrowUp, ChevronRight, Folder, House } from 'lucide-react';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { useTranslation } from '../../i18n';
import { useSshEnvironment } from '../../stores/environment';
import { folderBreadcrumbs } from './folder-picker';
import { settleSshHostFolder, useSshHostDialogsStore } from './ssh-host-dialogs-store';
import { useFolderBrowser } from './use-folder-browser';

type FolderEntry = MethodResult<'project.browseFolders'>['entries'][number];

const toolbarButtonClassName =
    'grid size-7 flex-none cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted enabled:hover:bg-elevated enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

/**
 * Chooses a Project folder on the SSH Host in place of the native folder picker, which can only see this Mac's disk.
 * The folders come from `project.browseFolders` on the window's own Server.
 */
export function SshHostFolderPickerDialog() {
    const isOpen = useSshHostDialogsStore((state) => state.resolveFolder !== undefined);
    const destination = useSshEnvironment()?.destination;
    return (
        <Dialog
            open={isOpen}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) settleSshHostFolder(undefined);
            }}
        >
            {isOpen && destination !== undefined && (
                <DialogContent className="w-[min(600px,calc(100vw-32px))]">
                    <FolderPickerBody destination={destination} />
                </DialogContent>
            )}
        </Dialog>
    );
}

function FolderPickerBody({ destination }: { destination: string }) {
    const { t } = useTranslation();
    const browser = useFolderBrowser();
    const { current } = browser;
    const crumbs = current ? folderBreadcrumbs(current.path, current.home) : [];
    return (
        <>
            <DialogHeader>
                <DialogTitle>{t('sshHost.folderPicker.title', { destination })}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2 px-4 pt-3">
                <div className="flex min-w-0 items-center gap-1">
                    <button
                        aria-label={t('sshHost.folderPicker.parent')}
                        className={toolbarButtonClassName}
                        disabled={!current?.parent}
                        type="button"
                        onClick={() => current?.parent && browser.navigate(current.parent)}
                    >
                        <ArrowUp aria-hidden="true" size={15} />
                    </button>
                    <button
                        aria-label={t('sshHost.folderPicker.home')}
                        className={toolbarButtonClassName}
                        disabled={!current}
                        type="button"
                        onClick={() => current && browser.navigate(current.home)}
                    >
                        <House aria-hidden="true" size={15} />
                    </button>
                    <nav
                        aria-label={t('sshHost.folderPicker.breadcrumbs')}
                        className="flex min-w-0 items-center overflow-hidden text-[12px] text-muted"
                    >
                        {crumbs.map((crumb, index) => (
                            <span key={crumb.path} className="flex min-w-0 items-center">
                                {index > 0 && crumbs[index - 1]?.label !== '/' && (
                                    <ChevronRight
                                        aria-hidden="true"
                                        className="flex-none"
                                        size={12}
                                    />
                                )}
                                <button
                                    aria-current={
                                        index === crumbs.length - 1 ? 'location' : undefined
                                    }
                                    className="cursor-pointer truncate rounded border-0 bg-transparent px-1 text-muted hover:bg-elevated hover:text-foreground aria-[current=location]:text-foreground"
                                    type="button"
                                    onClick={() => browser.navigate(crumb.path)}
                                >
                                    {crumb.label}
                                </button>
                            </span>
                        ))}
                    </nav>
                </div>
                <Input
                    autoFocus
                    aria-describedby={
                        browser.isInputInvalid ? 'ssh-host-folder-path-error' : undefined
                    }
                    aria-invalid={browser.isInputInvalid}
                    aria-label={t('sshHost.folderPicker.pathLabel')}
                    placeholder={t('sshHost.folderPicker.pathPlaceholder')}
                    size="dense"
                    spellCheck={false}
                    value={browser.inputValue}
                    onChange={(event) => browser.updateInput(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        browser.submitInput();
                    }}
                />
                {browser.isInputInvalid && (
                    <p
                        id="ssh-host-folder-path-error"
                        className="m-0 text-[11px] text-danger"
                        role="status"
                    >
                        {t('sshHost.folderPicker.invalidPath')}
                    </p>
                )}
            </div>
            <FolderList
                entries={current?.entries}
                isLoading={browser.isLoading}
                isNavigating={browser.isNavigating}
                loadError={browser.loadError}
                onOpen={(entry) => browser.navigate(entry.path)}
            />
            <div className="flex items-center gap-2 p-4 pt-2">
                <p className="m-0 min-w-0 flex-1 text-[11px] text-muted">
                    {current?.truncated &&
                        t('sshHost.folderPicker.truncated', { count: current.entries.length })}
                </p>
                <Button variant="secondary" onClick={() => settleSshHostFolder(undefined)}>
                    {t('common.cancel')}
                </Button>
                <Button
                    disabled={!current}
                    onClick={() => current && settleSshHostFolder(current.path)}
                >
                    {t('sshHost.folderPicker.open')}
                </Button>
            </div>
        </>
    );
}

function FolderList({
    entries,
    isLoading,
    isNavigating,
    loadError,
    onOpen,
}: {
    entries: readonly FolderEntry[] | undefined;
    isLoading: boolean;
    isNavigating: boolean;
    loadError: Error | null;
    onOpen: (entry: FolderEntry) => void;
}) {
    const { t } = useTranslation();
    return (
        <div
            aria-busy={isLoading || isNavigating}
            aria-label={t('sshHost.folderPicker.listLabel')}
            className="mx-4 mt-2 h-70 overflow-auto rounded border border-border bg-background p-1"
            role="list"
        >
            {loadError ? (
                <p className="m-0 p-2 text-[12px] text-danger" role="status">
                    {t('sshHost.folderPicker.loadFailed', { message: errorMessage(loadError, '') })}
                </p>
            ) : isLoading ? (
                <LoadingSkeleton label={t('sshHost.folderPicker.loading')} variant="list" />
            ) : entries?.length === 0 ? (
                <p className="m-0 p-2 text-[12px] text-muted">{t('sshHost.folderPicker.empty')}</p>
            ) : (
                entries?.map((entry) => (
                    <div key={entry.path} role="listitem">
                        <button
                            className="flex h-7 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:bg-list-focus-background focus-visible:text-list-focus-foreground focus-visible:outline-none"
                            type="button"
                            onClick={() => onOpen(entry)}
                        >
                            <Folder aria-hidden="true" className="flex-none text-muted" size={14} />
                            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                            {entry.isGitRepository && (
                                <span
                                    aria-label={t('sshHost.folderPicker.gitRepositoryDescription')}
                                    className="flex-none rounded bg-elevated px-1.5 text-[10px] text-muted"
                                >
                                    {t('sshHost.folderPicker.gitRepository')}
                                </span>
                            )}
                            {entry.hasChildren && (
                                <ChevronRight
                                    aria-hidden="true"
                                    className="flex-none text-muted"
                                    size={13}
                                />
                            )}
                        </button>
                    </div>
                ))
            )}
        </div>
    );
}
