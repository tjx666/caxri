import { useSelectedSession, useSelectedWorkbenchProject } from '../../stores/selectors';
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
}: {
    paneId: string;
    path: string;
    displayPath?: string;
    isExternal: boolean;
}) {
    const session = useSelectedSession();
    const project = useSelectedWorkbenchProject();
    if (!session || (isExternal && !displayPath)) return null;
    return (
        <div className="flex h-6 shrink-0 items-center overflow-hidden border-b border-border bg-surface">
            {isExternal ? (
                <EditorPathBreadcrumbs
                    accessibilityLabel={`File breadcrumbs: ${displayPath}`}
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
        </div>
    );
}
