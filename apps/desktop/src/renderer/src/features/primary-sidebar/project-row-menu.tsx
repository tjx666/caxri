import type { ReactElement } from 'react';

import type { ProjectRecord } from '@caxri/protocol';

import { executeCommand } from '../../commands/execute';
import { ContextMenuTrigger } from '../../components/context-menu-trigger';
import { translate } from '../../i18n';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import { copyFilePath } from '../../lib/copy-file-path';
import { environmentOfProject } from '../../lib/environment-routing';
import { deleteMergedProjects, hideSelectedProject } from '../session/project-removal-commands';
import { openProjectRoot } from './project-path-commands';

export function ProjectRowMenu({
    children,
    members,
    onOpenChange,
    project: lead,
}: {
    children: ReactElement;
    /**
     * Every machine's checkout under a merged heading. Hide and Delete act on all of them; the path entries prefer this
     * Mac's checkout.
     */
    members?: readonly ProjectRecord[];
    onOpenChange?: (isOpen: boolean) => void;
    project: ProjectRecord;
}) {
    return (
        <ContextMenuTrigger
            onOpenChange={onOpenChange}
            menu={() => {
                const all = members ?? [lead];
                const project =
                    all.find((member) => environmentOfProject(member.id) === undefined) ?? lead;
                // Finder and the external editor open this Mac's copy of the folder, which an SSH Host's Project lacks.
                const isLocal = environmentOfProject(project.id) === undefined;
                return [
                    {
                        label: translate('primarySidebar.projectMenu.copyPath'),
                        onSelect: () => copyFilePath(project.rootPath),
                    },
                    isLocal && {
                        label: translate('primarySidebar.projectMenu.revealInFinder'),
                        onSelect: () => openProjectRoot(project.id, 'finder'),
                    },
                    isLocal && {
                        label: translate('primarySidebar.projectMenu.openInEditor'),
                        onSelect: () => openProjectRoot(project.id, 'editor'),
                    },
                    CONTEXT_MENU_SEPARATOR,
                    /**
                     * A right-click does not change the selected Project, so this entry hides the clicked Project
                     * directly instead of going through `project.hide`, which the menu bar and command palette use for
                     * the selected Project.
                     */
                    {
                        label: translate('primarySidebar.projectMenu.hide'),
                        onSelect: () => {
                            for (const member of all) hideSelectedProject(member.id);
                        },
                    },
                    {
                        label: translate('primarySidebar.projectMenu.delete'),
                        onSelect: () =>
                            all.length > 1
                                ? deleteMergedProjects(all.map((member) => member.id))
                                : executeCommand('project.delete', { projectId: lead.id }),
                    },
                ];
            }}
        >
            {children}
        </ContextMenuTrigger>
    );
}
