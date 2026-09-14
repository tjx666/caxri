import type { ReactElement } from 'react';

import type { ProjectRecord } from '@caxri/protocol';

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { copyFilePath } from '../../lib/copy-file-path';
import { openProjectRoot } from './project-path-commands';

export function ProjectRowMenu({
    children,
    project,
}: {
    children: ReactElement;
    project: ProjectRecord;
}) {
    return (
        <ContextMenu>
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
            </ContextMenuContent>
        </ContextMenu>
    );
}
