import type { MouseEvent } from 'react';
import { useId } from 'react';

import type { FileEntry } from '@caxri/protocol';
import { ChevronRight } from 'lucide-react';

import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { isDirectoryEntry } from '../../lib/file-entry';
import { gitDecorationClassName, gitDecorationDescription } from '../../lib/git-decorations';
import { formatCount } from '../../lib/locale-format';
import { cn } from '../../lib/utilities';
import { useGitDecoration } from '../../stores/git-decorations';
import { describeFailure } from '../../stores/toasts';
import type { EditorBreadcrumbSegment } from './editor-breadcrumbs-model';
import { useEditorBreadcrumbPicker } from './hooks/use-editor-breadcrumb-picker';

/**
 * Preserves the listbox's single DOM focus while a pointer activates one of its virtual options.
 */
function keepListboxFocused(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
}

function EditorBreadcrumbPickerOption({
    active,
    entry,
    id,
    onClick,
    onPointerMove,
}: {
    active: boolean;
    entry: FileEntry;
    id: string;
    onClick: () => void;
    onPointerMove: () => void;
}) {
    const { t } = useTranslation();
    const pathDecoration = useGitDecoration(entry.path);
    const decoration = !isDirectoryEntry(entry) && !entry.gitIgnored ? pathDecoration : undefined;
    const decorationDescriptionId = useId();
    return (
        <button
            aria-label={entry.name}
            aria-describedby={decoration ? decorationDescriptionId : undefined}
            aria-selected={active}
            id={id}
            role="option"
            tabIndex={-1}
            className={cn(
                'flex h-7 w-full cursor-default items-center gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-foreground outline-none aria-selected:bg-[var(--selection)]',
                entry.gitIgnored && 'text-muted italic',
            )}
            data-git-ignored={entry.gitIgnored}
            onClick={onClick}
            onMouseDown={keepListboxFocused}
            onPointerMove={onPointerMove}
        >
            <FileTypeIcon entry={entry} />
            <span
                className={cn(
                    'min-w-0 flex-1 truncate',
                    decoration && gitDecorationClassName(decoration.kind),
                )}
            >
                {entry.name}
            </span>
            {decoration && (
                <>
                    <GitFileStatusLetter decoration={decoration} />
                    <span id={decorationDescriptionId} className="sr-only">
                        {gitDecorationDescription(decoration.kind, t)}
                    </span>
                </>
            )}
            {isDirectoryEntry(entry) && (
                <ChevronRight aria-hidden="true" className="flex-none text-muted" size={12} />
            )}
        </button>
    );
}

export function EditorBreadcrumbPicker({
    onOpenFile,
    projectRoot,
    segment,
    sessionId,
}: {
    onOpenFile: (path: string) => void;
    projectRoot: string;
    segment: EditorBreadcrumbSegment;
    sessionId: string;
}) {
    const { t } = useTranslation();
    const {
        activeOptionId,
        activePath,
        currentDirectory,
        directoryLabel,
        entries,
        error,
        isError,
        isPending,
        listboxReference,
        onEntryClick,
        onEntryPointerMove,
        onKeyDown,
        optionId,
        truncated,
    } = useEditorBreadcrumbPicker({ onOpenFile, projectRoot, segment, sessionId });
    return (
        <div data-breadcrumb-directory={currentDirectory}>
            <div
                ref={listboxReference}
                aria-activedescendant={activeOptionId}
                aria-busy={isPending}
                aria-label={t('editor.breadcrumbs.contentsOf', { directory: directoryLabel })}
                role="listbox"
                tabIndex={0}
                className="max-h-72 overflow-y-auto p-1 outline-none"
                onKeyDown={onKeyDown}
            >
                {isPending && (
                    <div
                        aria-disabled="true"
                        aria-selected="false"
                        className="flex h-7 items-center gap-2 px-2 text-muted"
                        role="option"
                    >
                        <Spinner aria-hidden="true" size={12} />
                        <span aria-live="polite" role="status">
                            {t('editor.breadcrumbs.loadingFolder')}
                        </span>
                    </div>
                )}
                {isError && (
                    <div
                        aria-disabled="true"
                        aria-selected="false"
                        className="px-2 py-2 text-danger"
                        role="option"
                    >
                        <span role="alert">
                            {describeFailure(error, t('editor.breadcrumbs.readFolderFailed'), t)}
                        </span>
                    </div>
                )}
                {!isPending && !isError && entries.length === 0 && (
                    <div
                        aria-disabled="true"
                        aria-selected="false"
                        className="px-2 py-2 text-muted italic"
                        role="option"
                    >
                        {t('editor.breadcrumbs.emptyFolder')}
                    </div>
                )}
                {!isPending &&
                    !isError &&
                    entries.map((entry, index) => (
                        <EditorBreadcrumbPickerOption
                            key={entry.path}
                            active={entry.path === activePath}
                            entry={entry}
                            id={optionId(index)}
                            onClick={() => onEntryClick(entry)}
                            onPointerMove={() => onEntryPointerMove(entry)}
                        />
                    ))}
            </div>
            {truncated && (
                <div aria-live="polite" className="px-2 py-1 text-[11px] text-muted" role="status">
                    {t('editor.breadcrumbs.truncated', {
                        count: formatCount(entries.length),
                    })}
                </div>
            )}
        </div>
    );
}
