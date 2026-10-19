import type { ReactNode } from 'react';
import { useRef } from 'react';

import { Maximize2 } from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { Dialog, DialogContent } from '../ui/dialog';
import { Tooltip } from '../ui/tooltip';

/**
 * The ghost button a transcript block's hover toolbar uses to open {@link BlockFullscreenDialog}, matching
 * `CopyIconButton`'s size and states so the two sit as one group.
 */
export function BlockFullscreenButton({ onOpen }: { onOpen: () => void }) {
    const { t } = useTranslation();
    const label = t('core.block.fullscreen');
    return (
        <Tooltip content={label}>
            <button
                aria-label={label}
                className="flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={onOpen}
            >
                <Maximize2 className="size-3.5" />
            </button>
        </Tooltip>
    );
}

/**
 * A wide table, a long code block, or a diagram read at the size of the window instead of the transcript's column, as
 * the ChatGPT and Claude apps open an artifact. The dialog fills the window less a 32px margin, with the block's name
 * and its actions (Copy, word wrap) in a 44px header and the body scrolling under it. Escape, the close button, or a
 * click outside returns to the transcript where the reader left it.
 */
export function BlockFullscreenDialog({
    actions,
    bodyClassName,
    children,
    isOpen,
    title,
    onOpenChange,
}: {
    /**
     * The block's own toolbar buttons, shown always (not on hover) in the header.
     */
    actions?: ReactNode;
    bodyClassName?: string;
    children: ReactNode;
    isOpen: boolean;
    title: string;
    onOpenChange: (isOpen: boolean) => void;
}) {
    const bodyReference = useRef<HTMLDivElement>(null);
    return (
        <Dialog open={isOpen} onOpenChange={onOpenChange}>
            {isOpen && (
                <DialogContent
                    // Focus the scrolling body, not the first toolbar button: arrow keys and Page Down scroll the
                    // block at once, and the Copy tooltip does not pop up the moment the dialog opens.
                    initialFocus={bodyReference}
                    className="flex h-[calc(100vh-64px)] max-h-none w-[calc(100vw-64px)] flex-col overflow-hidden"
                >
                    <div className="flex h-11 shrink-0 items-center gap-1 border-0 border-b border-solid border-border pr-11 pl-4 select-none">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
                            {title}
                        </span>
                        {actions}
                    </div>
                    <div
                        ref={bodyReference}
                        className={cn('min-h-0 flex-1 overflow-auto outline-none', bodyClassName)}
                        tabIndex={-1}
                    >
                        {children}
                    </div>
                </DialogContent>
            )}
        </Dialog>
    );
}
