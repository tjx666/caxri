import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { Button } from '../ui/button';

/**
 * The pill that folds a long code block, as Linear's documents set it. Collapsed, it floats over a fade that dissolves
 * the cut-off lines into the block's `--elevated` fill and names how many lines the block holds; expanded, it sits
 * below the last line so it never covers code. Its parent must be the positioned box around the code.
 */
export function CodeCollapseToggle({
    isExpanded,
    lineCount,
    onToggle,
}: {
    isExpanded: boolean;
    lineCount: number;
    onToggle: () => void;
}) {
    const { t } = useTranslation();
    const Icon = isExpanded ? ChevronsDownUp : ChevronsUpDown;
    return (
        <div
            className={cn(
                'flex justify-center select-none',
                isExpanded
                    ? 'pb-2'
                    : 'pointer-events-none absolute inset-x-0 bottom-0 h-12 items-end bg-gradient-to-t from-elevated to-transparent pb-2',
            )}
        >
            <Button
                aria-expanded={isExpanded}
                className="pointer-events-auto h-6 gap-1 rounded-full border border-border bg-elevated px-2.5 text-[12px] text-muted shadow-[0_4px_12px_var(--shadow)] hover:text-foreground"
                size="sm"
                variant="ghost"
                onClick={onToggle}
            >
                <Icon aria-hidden="true" className="size-3.5" />
                {isExpanded
                    ? t('core.codeView.collapse')
                    : t('core.codeView.expand', { count: lineCount })}
            </Button>
        </div>
    );
}
