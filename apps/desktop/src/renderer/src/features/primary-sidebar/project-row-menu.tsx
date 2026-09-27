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
import { hideSelectedProject } from '../session/project-removal-commands';
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
                {/*
                 * A right-click does not change the selected Project, so this entry hides the clicked Project
                 * directly instead of going through `project.hide`, which the menu bar and command palette use for
                 * the selected Project.
                 */}
                <ContextMenuItem onClick={() => hideSelectedProject(project.id)}>
                    Hide Project
                </ContextMenuItem>
                <ContextMenuItem
                    onClick={() => executeCommand('project.delete', { projectId: project.id })}
                >
                    Delete Project…
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
