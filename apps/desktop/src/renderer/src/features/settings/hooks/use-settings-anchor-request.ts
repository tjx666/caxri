import { useCallback, useRef, useState } from 'react';

/**
 * The category or `category:subcategory` anchor the Settings navigation last asked for.
 *
 * It is a request rather than a scroll call because the navigation stays mounted over Keybindings, Theme, and Source,
 * where the Settings list it scrolls does not exist yet; `SettingsPage` consumes it once its rows have mounted and then
 * completes it, so a later remount (back from Source, Theme, or Keybindings) does not scroll to it again.
 */
export function useSettingsAnchorRequest(showSettingsList: () => void): {
    anchorRequest: { id: number; anchor: string } | undefined;
    navigateToAnchor: (anchor: string) => void;
    completeAnchorRequest: (id: number) => void;
} {
    const [anchorRequest, setAnchorRequest] = useState<{ id: number; anchor: string }>();
    const lastAnchorRequestId = useRef(0);
    const navigateToAnchor = (anchor: string): void => {
        showSettingsList();
        lastAnchorRequestId.current += 1;
        setAnchorRequest({ id: lastAnchorRequestId.current, anchor });
    };
    const completeAnchorRequest = useCallback((id: number): void => {
        setAnchorRequest((current) => (current?.id === id ? undefined : current));
    }, []);
    return { anchorRequest, navigateToAnchor, completeAnchorRequest };
}
