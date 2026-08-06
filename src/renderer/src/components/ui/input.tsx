import { Input as InputPrimitive } from '@base-ui/react/input';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Base UI input primitive styled to the DESIGN.md field redline: 36px row, 4px radius,
 * a themed (not OS-scheme) fill so an imported theme controls how a field reads.
 */
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
    return (
        <InputPrimitive
            type={type}
            data-slot="input"
            className={cn(
                'block h-9 w-full min-w-0 rounded border border-border bg-[color-mix(in_srgb,var(--border)_30%,transparent)] px-2 text-[13px] text-inherit outline-none transition-[border-color,box-shadow] duration-150 ease-out placeholder:text-muted focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_50%,transparent)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
                className,
            )}
            {...props}
        />
    );
}
