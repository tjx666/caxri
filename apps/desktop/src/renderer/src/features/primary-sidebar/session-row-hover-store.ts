import { create } from 'zustand';

/**
 * Only the action chips subscribe, so hovering a row never invalidates its title, status, or siblings.
 */
export const useSessionRowHoverStore = create<{ rowId: string | undefined }>(() => ({
    rowId: undefined,
}));

export function setSessionRowHovered(rowId: string, isHovered: boolean): void {
    const current = useSessionRowHoverStore.getState().rowId;
    if (isHovered && current !== rowId) useSessionRowHoverStore.setState({ rowId });
    else if (!isHovered && current === rowId)
        useSessionRowHoverStore.setState({ rowId: undefined });
}
