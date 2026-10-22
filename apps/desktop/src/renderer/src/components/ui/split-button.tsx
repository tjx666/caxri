import type { ReactNode } from 'react';

import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utilities';

import type { ButtonProperties } from './button';
import { Button } from './button';

/**
 * A default action joined to a dropdown of the alternatives: the leading half performs the default immediately, the
 * trailing half opens the full list. VS Code's New Terminal control is the same shape
 * (`DropdownWithPrimaryActionViewItem` in `src/vs/workbench/contrib/terminal/browser/terminalEditor.ts`).
 *
 * The two halves are two real buttons rather than one button with a hot zone, so each is its own Tab stop and the
 * dropdown half keeps everything the shared `Menu` already provides: arrow-key navigation, Escape, focus return.
 * Compose it as `SplitButtonAction` + a `Menu` whose `MenuTrigger` renders `SplitButtonTrigger`.
 */
export function SplitButton({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn('inline-flex items-stretch', className)}>{children}</div>;
}

/**
 * The leading half. Its accessible name must say what the action will actually do, not just name the control, because
 * the user never sees the list before it runs.
 */
export function SplitButtonAction({ className, ...properties }: ButtonProperties) {
    return <Button className={cn('rounded-r-none', className)} {...properties} />;
}

/**
 * The trailing half: chevron only, sized down to a hairline-separated sliver so the pair reads as one control.
 *
 * The separator is an inset shadow rather than a left border because the shared `Button` already paints a
 * `border-transparent` on all four sides, and a border color class would repaint the whole outline instead of the one
 * seam. `menu.tsx` draws its popup hairline the same way.
 */
export function SplitButtonTrigger({
    children,
    className,
    size = 'sm',
    ...properties
}: ButtonProperties) {
    return (
        <Button
            className={cn('rounded-l-none px-1 shadow-[inset_1px_0_0_var(--border)]', className)}
            size={size}
            {...properties}
        >
            {children === undefined ? <ChevronDown aria-hidden="true" size={11} /> : children}
        </Button>
    );
}
