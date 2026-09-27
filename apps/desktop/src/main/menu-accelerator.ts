/**
 * Keybinding key names are DOM `KeyboardEvent.key` values lowercased; Electron accelerators use its own token set. Any
 * name that differs between the two has to be translated explicitly — an unmapped name falls through uppercased, and
 * Electron silently refuses to register the accelerator (`ARROWLEFT` is not a token, `Left` is), leaving the menu item
 * with no working shortcut even though the Renderer's own DOM handler still fires.
 *
 * @see https://www.electronjs.org/docs/latest/api/accelerator
 */
export function electronAccelerator(key: string | undefined): string | undefined {
    if (!key) return undefined;
    const names: Record<string, string> = {
        'cmd': 'Command',
        'command': 'Command',
        'ctrl': 'Control',
        'control': 'Control',
        'alt': 'Alt',
        'option': 'Alt',
        'shift': 'Shift',
        'arrowup': 'Up',
        'arrowdown': 'Down',
        'arrowleft': 'Left',
        'arrowright': 'Right',
        'escape': 'Escape',
        'enter': 'Return',
        'backspace': 'Backspace',
        'delete': 'Delete',
        ' ': 'Space',
        'space': 'Space',
    };
    return key
        .split('+')
        .map((part) => names[part.trim().toLowerCase()] ?? part.trim().toUpperCase())
        .join('+');
}
