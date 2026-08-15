/**
Canonical chord normalization shared by dispatch, editing, and conflict detection.
 */
export function normalizeShortcut(value: string): string {
    return value
        .toLowerCase()
        .replaceAll('command', 'cmd')
        .split('+')
        .map((part) => part.trim())
        .toSorted((a, b) => {
            const order = ['cmd', 'ctrl', 'alt', 'shift'];
            const left = order.indexOf(a);
            const right = order.indexOf(b);
            return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
        })
        .join('+');
}
