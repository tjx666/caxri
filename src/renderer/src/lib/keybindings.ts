/** Shortcut normalization shared by the keybinding table and the global keydown dispatcher. */
export function normalizeShortcut(value: string): string {
    return value
        .toLowerCase()
        .replaceAll('command', 'cmd')
        .split('+')
        .map((part) => part.trim())
        .sort((a, b) => {
            const order = ['cmd', 'ctrl', 'alt', 'shift'];
            const left = order.indexOf(a);
            const right = order.indexOf(b);
            return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
        })
        .join('+');
}

export function keyboardEventShortcut(event: KeyboardEvent): string {
    return normalizeShortcut(
        [
            event.metaKey && 'cmd',
            event.ctrlKey && 'ctrl',
            event.altKey && 'alt',
            event.shiftKey && 'shift',
            event.key.length === 1 ? event.key : event.key.toLowerCase(),
        ]
            .filter(Boolean)
            .join('+'),
    );
}
