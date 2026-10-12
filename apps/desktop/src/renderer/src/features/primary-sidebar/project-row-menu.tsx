import type { ReactElement } from 'react';

import type { ProjectRecord } from '@caxri/protocol';

import { executeCommand } from '../../commands/execute';
import { ContextMenuTrigger } from '../../components/context-menu-trigger';
import { translate } from '../../i18n';
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
                {
                    label: translate('primarySidebar.projectMenu.copyPath'),
                    onSelect: () => copyFilePath(project.rootPath),
                },
                {
                    label: translate('primarySidebar.projectMenu.revealInFinder'),
                    onSelect: () => openProjectRoot(project.id, 'finder'),
                },
                {
                    label: translate('primarySidebar.projectMenu.openInEditor'),
                    onSelect: () => openProjectRoot(project.id, 'editor'),
                },
                CONTEXT_MENU_SEPARATOR,
                /**
                 * A right-click does not change the selected Project, so this entry hides the clicked Project directly
                 * instead of going through `project.hide`, which the menu bar and command palette use for the selected
                 * Project.
                 */
                {
                    label: translate('primarySidebar.projectMenu.hide'),
                    onSelect: () => hideSelectedProject(project.id),
                },
                {
                    label: translate('primarySidebar.projectMenu.delete'),
                    onSelect: () => executeCommand('project.delete', { projectId: project.id }),
                },
            ]}
        >
            {children}
        </ContextMenuTrigger>
    );
}
