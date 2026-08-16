import { formatShortcut, formatShortcutParts } from '../lib/keybindings';
import { cn } from '../lib/utilities';

interface ShortcutBadgeProperties {
    className?: string;
    compact?: boolean;
    keyClassName?: string;
    shortcut: string;
}

/**
 * Shared macOS keycap presentation for live and draft shortcuts.
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
                <kbd
                    key={`${part}-${index}`}
                    aria-hidden="true"
                    className={cn(
                        'inline-flex items-center justify-center rounded border border-border bg-elevated font-sans leading-none text-foreground',
                        compact ? 'h-4 min-w-4 px-0.5 text-[10px]' : 'h-6 min-w-6 px-1 text-[11px]',
                        keyClassName,
                    )}
                >
                    {part}
                </kbd>
            ))}
        </span>
    );
}
