import type { KeyboardEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import { editorModelPath } from '@desktop-shared/editor-state';
import { ChevronRight } from 'lucide-react';

import { GitFileStatusLetter } from '../../components/git-file-status-letter';
import type { PopoverActions } from '../../components/ui/popover';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { useTranslation } from '../../i18n';
import { FileTypeIcon } from '../../icons/files/file-type-icon';
import { gitDecorationClassName, gitDecorationDescription } from '../../lib/git-decorations';
import { cn } from '../../lib/utilities';
import { useGitDecoration } from '../../stores/git-decorations';
import { sessionViewScope } from '../../stores/session-view';
import { openFileForSession } from './document-commands';
import { EditorBreadcrumbPicker } from './editor-breadcrumb-picker';
import type { EditorBreadcrumbSegment } from './editor-breadcrumbs-model';
import { editorBreadcrumbSegments } from './editor-breadcrumbs-model';
import { focusEditor } from './editor-reveal';

export function EditorBreadcrumbs({
    accessibilityLabel,
    onEscapeToEditor,
    paneId,
    path,
    projectRoot,
    sessionId,
    workbenchProjectId,
}: {
    accessibilityLabel?: string;
    onEscapeToEditor?: () => void;
    paneId: string;
    path: string;
    projectRoot: string;
    sessionId: string;
    workbenchProjectId: string;
}) {
    const { t } = useTranslation();
    const segments = editorBreadcrumbSegments(path, projectRoot);
    const decoration = useGitDecoration(path);
    const decorationDescriptionId = useId();
    const [requestedTabStopPath, setRequestedTabStopPath] = useState(path);
    const actionsReference = useRef<PopoverActions>(null);
    const segmentReferences = useRef(new Map<string, HTMLButtonElement>());
    const modelPath = editorModelPath(sessionViewScope(sessionId, workbenchProjectId), path);
    const tabStopPath = segments.some((segment) => segment.path === requestedTabStopPath)
        ? requestedTabStopPath
        : path;

    useEffect(() => {
        segmentReferences.current.get(path)?.scrollIntoView({ block: 'nearest', inline: 'end' });
    }, [path]);

    if (segments.length === 0) return null;

    const focusSegment = (index: number): void => {
        const segment = segments.at(Math.max(0, Math.min(segments.length - 1, index)));
        if (!segment) return;
        setRequestedTabStopPath(segment.path);
        segmentReferences.current.get(segment.path)?.focus();
    };

    const onSegmentKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
        switch (event.key) {
            case 'ArrowLeft': {
                event.preventDefault();
                focusSegment(index - 1);
                break;
            }
            case 'ArrowRight': {
                event.preventDefault();
                focusSegment(index + 1);
                break;
            }
            case 'Home': {
                event.preventDefault();
                focusSegment(0);
                break;
            }
            case 'End': {
                event.preventDefault();
                focusSegment(segments.length - 1);
                break;
            }
            case 'Escape': {
                event.preventDefault();
                if (onEscapeToEditor) onEscapeToEditor();
                else focusEditor(modelPath, paneId);
                break;
            }
        }
    };

    const openFileFromPicker = (targetPath: string): void => {
        actionsReference.current?.close();
        // `openFileForSession` reports read failures and queues Editor focus when the new model has not mounted yet.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void openFileForSession(sessionId, targetPath, {
            focus: true,
            paneId,
            preview: true,
        });
    };

    return (
        <Popover<EditorBreadcrumbSegment> actionsRef={actionsReference}>
            {({ payload }) => (
                <>
                    <nav
                        aria-label={
                            accessibilityLabel ??
                            t('editor.breadcrumbs.fileLabel', {
                                path: segments.at(-1)?.relativePath ?? path,
                            })
                        }
                        className="editor-breadcrumbs flex min-w-0 flex-1 items-center overflow-x-auto px-2 text-[12px] text-muted"
                    >
                        {segments.map((segment, index) => (
                            <div key={segment.path} className="flex shrink-0 items-center">
                                {index > 0 && (
                                    <ChevronRight
                                        aria-hidden="true"
                                        className="shrink-0 text-muted"
                                        size={12}
                                    />
                                )}
                                <PopoverTrigger
                                    payload={segment}
                                    render={
                                        <button
                                            ref={(element) => {
                                                if (element)
                                                    segmentReferences.current.set(
                                                        segment.path,
                                                        element,
                                                    );
                                                else segmentReferences.current.delete(segment.path);
                                            }}
                                            aria-current={
                                                segment.kind === 'file' ? 'page' : undefined
                                            }
                                            aria-label={t('editor.breadcrumbs.browse', {
                                                path: segment.relativePath,
                                            })}
                                            aria-describedby={
                                                decoration && segment.kind === 'file'
                                                    ? decorationDescriptionId
                                                    : undefined
                                            }
                                            tabIndex={segment.path === tabStopPath ? 0 : -1}
                                            type="button"
                                            className="flex h-6 max-w-64 items-center gap-1 rounded border-0 bg-transparent px-1 text-inherit outline-none hover:bg-elevated hover:text-foreground focus-visible:bg-[var(--selection)] focus-visible:text-foreground aria-current:text-foreground"
                                            onFocus={() => setRequestedTabStopPath(segment.path)}
                                            onKeyDown={(event) => onSegmentKeyDown(event, index)}
                                        >
                                            {segment.kind === 'file' && (
                                                <FileTypeIcon
                                                    entry={{ kind: 'file', name: segment.label }}
                                                />
                                            )}
                                            <span
                                                className={cn(
                                                    'truncate',
                                                    segment.kind === 'file' &&
                                                        decoration &&
                                                        gitDecorationClassName(decoration.kind),
                                                )}
                                            >
                                                {segment.label}
                                            </span>
                                            {segment.kind === 'file' && decoration && (
                                                <>
                                                    <GitFileStatusLetter decoration={decoration} />
                                                    <span
                                                        id={decorationDescriptionId}
                                                        className="sr-only"
                                                    >
                                                        {gitDecorationDescription(decoration.kind)}
                                                    </span>
                                                </>
                                            )}
                                        </button>
                                    }
                                />
                            </div>
                        ))}
                    </nav>
                    {payload && (
                        <PopoverContent
                            aria-label={t('editor.breadcrumbs.browse', {
                                path: payload.relativePath,
                            })}
                        >
                            <EditorBreadcrumbPicker
                                key={payload.path}
                                onOpenFile={openFileFromPicker}
                                projectRoot={projectRoot}
                                segment={payload}
                                sessionId={sessionId}
                            />
                        </PopoverContent>
                    )}
                </>
            )}
        </Popover>
    );
}
