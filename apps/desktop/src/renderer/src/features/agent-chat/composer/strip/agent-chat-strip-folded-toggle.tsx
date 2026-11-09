import { Button } from '../../../../components/ui/button';
import { Tooltip } from '../../../../components/ui/tooltip';
import { cn } from '../../../../lib/utilities';

/**
 * The quiet `Ended N` / `Completed N` disclosure among a strip section's actions, revealing the settled items the
 * section keeps out of its list so finished work never costs rows of its own. Folding finished work behind one quiet
 * control follows Synara and Claude Code's `Completed` group.
 */
export function AgentChatStripFoldedToggle({
    hideLabel,
    isShowing,
    label,
    listId,
    showLabel,
    onToggle,
}: {
    /**
     * The tooltip while the items show, and the one while they are hidden.
     */
    hideLabel: string;
    isShowing: boolean;
    /**
     * The visible text, naming the count (`Ended 3`).
     */
    label: string;
    listId: string;
    showLabel: string;
    onToggle: () => void;
}) {
    return (
        <Tooltip content={isShowing ? hideLabel : showLabel}>
            <Button
                aria-controls={listId}
                aria-expanded={isShowing}
                className={cn(
                    'h-6 shrink-0 px-1.5 text-[11px] text-muted tabular-nums hover:text-foreground',
                    isShowing && 'text-foreground',
                )}
                size="sm"
                variant="ghost"
                onClick={onToggle}
            >
                {label}
            </Button>
        </Tooltip>
    );
}
