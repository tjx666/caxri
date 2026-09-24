import type { ReactElement } from 'react';

import type { ProjectRecord } from '@caxri/protocol';

import { executeCommand } from '../../commands/execute';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { copyFilePath } from '../../lib/copy-file-path';
import { openProjectRoot } from './project-path-commands';

export function ProjectRowMenu({
    children,
    onOpenChange,
    project,
}: {
    children: ReactElement;
    onOpenChange?: (isOpen: boolean) => void;
    project: ProjectRecord;
}) {
    return (
        <ContextMenu onOpenChange={onOpenChange}>
            <ContextMenuTrigger render={children} />
            <ContextMenuContent aria-label={`${project.displayTitle} actions`}>
                <ContextMenuItem onClick={() => copyFilePath(project.rootPath)}>
                    Copy Path
                </ContextMenuItem>
                <ContextMenuItem onClick={() => openProjectRoot(project.id, 'finder')}>
                    Reveal in Finder
                </ContextMenuItem>
                <ContextMenuItem onClick={() => openProjectRoot(project.id, 'editor')}>
                    Open Project in Editor
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                    onClick={() => executeCommand('project.delete', { projectId: project.id })}
                >
                    Delete Project…
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
