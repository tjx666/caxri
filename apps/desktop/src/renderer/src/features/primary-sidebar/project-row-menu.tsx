import type { ReactElement } from 'react';

import type { ProjectRecord } from '@caxri/protocol';

import { executeCommand } from '../../commands/execute';
import { ContextMenuTrigger } from '../../components/context-menu-trigger';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
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
        <ContextMenuTrigger
            onOpenChange={onOpenChange}
            menu={() => [
                { label: 'Copy Path', onSelect: () => copyFilePath(project.rootPath) },
                {
                    label: 'Reveal in Finder',
                    onSelect: () => openProjectRoot(project.id, 'finder'),
                },
                {
                    label: 'Open Project in Editor',
                    onSelect: () => openProjectRoot(project.id, 'editor'),
                },
                CONTEXT_MENU_SEPARATOR,
                /**
                 * A right-click does not change the selected Project, so this entry hides the clicked Project directly
                 * instead of going through `project.hide`, which the menu bar and command palette use for the selected
                 * Project.
                 */
                { label: 'Hide Project', onSelect: () => hideSelectedProject(project.id) },
                {
                    label: 'Delete Project…',
                    onSelect: () => executeCommand('project.delete', { projectId: project.id }),
                },
            ]}
        >
            {children}
        </ContextMenuTrigger>
    );
}
