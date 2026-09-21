import { formatShortcut, formatShortcutChords } from '@caxri/protocol';

import { cn } from '../lib/utilities';
import { Kbd } from './ui/kbd';

interface ShortcutBadgeProperties {
    className?: string;
    compact?: boolean;
    keyClassName?: string;
    shortcut: string;
}

/**
 * Shared macOS keycap presentation for live and draft shortcuts, built on the shared `Kbd` chip. A two-chord keybinding
 * renders as two keycap groups with a wider gap between them, so `⌘K ⌘S` reads as two presses rather than one four-key
 * combination.
 */
export function ShortcutBadge({
    className,
    compact = false,
    keyClassName,
    shortcut,
}: ShortcutBadgeProperties) {
    return (
        <span
            aria-label={formatShortcut(shortcut)}
            className={cn('inline-flex shrink-0 items-center gap-1.5', className)}
            data-shortcut={shortcut}
        >
            {formatShortcutChords(shortcut).map((parts, chordIndex) => (
                <span
                    key={`chord-${chordIndex}`}
                    className="inline-flex shrink-0 items-center gap-0.5"
                >
                    {parts.map((part, index) => (
                        <Kbd
                            key={`${part}-${index}`}
                            aria-hidden="true"
                            className={keyClassName}
                            size={compact ? 'compact' : 'default'}
                        >
                            {part}
                        </Kbd>
                    ))}
                </span>
            ))}
        </span>
    );
}
