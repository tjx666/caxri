import { useTranslation } from '../../i18n';
import { useProjectById } from '../../stores/selectors';
import { usePaneViewSession } from '../workbench/pane-view-session';
import { EditorBreadcrumbs } from './editor-breadcrumbs';
import { EditorPathBreadcrumbs } from './editor-path-breadcrumbs';

/**
 * External documents expose their display path without offering Project-scoped sibling navigation.
 */
export function FileEditorBreadcrumbs({
    paneId,
    path,
    displayPath,
    isExternal,
    readOnly,
}: {
    paneId: string;
    path: string;
    displayPath?: string;
    isExternal: boolean;
    readOnly?: boolean;
}) {
    const { t } = useTranslation();
    const session = usePaneViewSession();
    const project = useProjectById(session?.workbenchProjectId);
    if (!session || (isExternal && !displayPath)) return null;
    return (
        <div className="flex h-6 shrink-0 items-center overflow-hidden border-b border-border bg-surface">
            {isExternal ? (
                <EditorPathBreadcrumbs
                    accessibilityLabel={t('editor.breadcrumbs.fileLabel', {
                        path: displayPath ?? '',
                    })}
                    path={displayPath!}
                />
            ) : project ? (
                <EditorBreadcrumbs
                    paneId={paneId}
                    path={path}
                    projectRoot={project.rootPath}
                    sessionId={session.id}
                    workbenchProjectId={session.workbenchProjectId}
                />
            ) : null}
            {readOnly && (
                <span className="mr-2 shrink-0 text-xs text-muted">
                    {t('editor.breadcrumbs.readOnly')}
                </span>
            )}
        </div>
    );
}
