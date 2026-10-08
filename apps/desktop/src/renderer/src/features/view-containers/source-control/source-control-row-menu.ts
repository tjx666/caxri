import type { SourceControlAction } from '@caxri/protocol';

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
