import type { MouseEvent, ReactElement } from 'react';
import { cloneElement } from 'react';

import type { ContextMenuOptions } from '../hooks/use-context-menu';
import { useContextMenu } from '../hooks/use-context-menu';
import type { ContextMenuEntries } from '../lib/context-menu';

interface ContextMenuTargetProperties {
    onContextMenu?: (event: MouseEvent) => void;
}

/**
 * Attaches a native right-click menu to its single child without adding a wrapper element, for components that receive
 * the row they decorate as `children`. The child's own `onContextMenu` still runs first.
 */
export function ContextMenuTrigger({
    children,
    menu,
    onOpenChange,
}: {
    children: ReactElement;
    menu: () => ContextMenuEntries | Promise<ContextMenuEntries>;
} & ContextMenuOptions) {
    const openMenu = useContextMenu(menu, { onOpenChange });
    const target = children as ReactElement<ContextMenuTargetProperties>;
    const ownHandler = target.props.onContextMenu;
    return cloneElement(target, {
        onContextMenu: (event: MouseEvent) => {
            ownHandler?.(event);
            openMenu(event);
        },
    });
}
