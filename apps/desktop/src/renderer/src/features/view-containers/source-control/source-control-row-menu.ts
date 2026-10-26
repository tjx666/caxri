import type { SourceControlAction } from '@caxri/protocol';

import { translate } from '../../../i18n';
import type { ContextMenuEntries } from '../../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../../lib/context-menu';
import { copyFileName, copyFilePath, relativePathRoot } from '../../../lib/copy-file-path';
import { selectSelectedWorkbenchProject } from '../../../stores/selectors';
import { useWorkbenchStore } from '../../../stores/workbench';

/**
 * One entry in a Source Control row's `Shift+F10` context menu.
 *
 * Deliberately not `SourceControlAction`: a row's menu also has to carry Renderer-owned entries that are not
 * Server-registered actions. The provider row's uncommitted notice is the case that forced it: the protocol keeps that
 * switch out of the action registry on purpose (`sourceControlProviderSchema` `uncommittedNotice`), because dispatching
 * a mode change as an action id would give one state change two dispatch paths.
 */
export interface SourceControlRowMenuItem {
    id: string;
    label: string;
    disabled?: boolean;
    run: () => void;
}

/**
 * Projects a row's Server-registered actions onto the menu shape, so a row's inline buttons and its context menu can
 * never drift apart.
 */
export function sourceControlActionMenuItems(
    actions: readonly SourceControlAction[] | undefined,
    run: (action: SourceControlAction) => void,
): SourceControlRowMenuItem[] {
    return (actions ?? []).map((action) => ({
        id: action.id,
        label: action.label,
        disabled: action.disabled,
        run: () => run(action),
    }));
}

/**
 * The clipboard entries a changed-file row offers after its Server-registered actions, matching the Editor tab and the
 * Files tree row for the same file. Built when the menu opens, so it reads the selected Project root live instead of
 * subscribing every visible row to it.
 *
 * The relative path measures from the Project root and falls back to the repository root for a linked repository
 * outside the Project (`relativePathRoot`), the same rule the single-file diff tab uses, so both menus copy one
 * string.
 *
 * @param absolutePath The changed file's path, already resolved against its repository root.
 * @param repoRootPath The owning repository's root.
 */
export function sourceControlResourcePathMenu(
    absolutePath: string,
    repoRootPath: string | undefined,
): ContextMenuEntries {
    const projectRoot = selectSelectedWorkbenchProject(
        useWorkbenchStore.getState().bootstrap,
    )?.rootPath;
    const relativeRoot = relativePathRoot(absolutePath, projectRoot, repoRootPath);
    return [
        CONTEXT_MENU_SEPARATOR,
        {
            label: translate('viewContainers.sourceControl.menu.copyPath'),
            onSelect: () => copyFilePath(absolutePath),
        },
        relativeRoot !== undefined && {
            label: translate('viewContainers.sourceControl.menu.copyRelativePath'),
            onSelect: () => copyFilePath(absolutePath, relativeRoot),
        },
        {
            label: translate('viewContainers.sourceControl.menu.copyName'),
            onSelect: () => copyFileName(absolutePath),
        },
    ];
}
