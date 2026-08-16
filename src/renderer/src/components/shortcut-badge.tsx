import { formatShortcut, formatShortcutParts } from '../lib/keybindings';
import { cn } from '../lib/utilities';
import { Kbd } from './ui/kbd';

interface ShortcutBadgeProperties {
    className?: string;
    compact?: boolean;
    keyClassName?: string;
    shortcut: string;
}

/**
 * Shared macOS keycap presentation for live and draft shortcuts, built on the shared `Kbd` chip.
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
            className={cn('inline-flex shrink-0 items-center gap-0.5', className)}
            data-shortcut={shortcut}
        >
            {formatShortcutParts(shortcut).map((part, index) => (
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
    );
}
