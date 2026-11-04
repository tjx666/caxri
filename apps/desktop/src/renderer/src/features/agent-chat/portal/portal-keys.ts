/**
 * The tab a Left/Right/Home/End key moves the Side View header to, wrapping at the ends like a native tab strip. Any
 * other key, or a strip with nothing to move to, returns `undefined`.
 */
export function nextPortalTabPath(
    paths: readonly string[],
    activePath: string,
    key: string,
): string | undefined {
    if (paths.length < 2) return undefined;
    const index = paths.indexOf(activePath);
    if (index === -1) return undefined;
    switch (key) {
        case 'ArrowRight':
            return paths[(index + 1) % paths.length];
        case 'ArrowLeft':
            return paths[(index - 1 + paths.length) % paths.length];
        case 'Home':
            return paths[0];
        case 'End':
            return paths.at(-1);
        default:
            return undefined;
    }
}

/**
 * Whether opening the Side View should move focus into it: only when the user opened it from the keyboard (the trigger
 * shows a focus ring and is not a text field), and not when focus is already inside it. A pointer click, a command, or
 * an Agent event that opens it never pulls focus away from the Chat composer the user is typing in.
 */
export function shouldFocusPortalOnOpen(trigger: {
    isEditable: boolean;
    isFocusVisible: boolean;
    isInsidePortal: boolean;
}): boolean {
    return trigger.isFocusVisible && !trigger.isEditable && !trigger.isInsidePortal;
}

/**
 * The DOM id of the Side View's tab at `index`, derived from the component's `useId` so two windows' ids never collide.
 */
export function portalTabId(base: string, index: number): string {
    return `${base}-tab-${index}`;
}
