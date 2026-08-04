import { Input as InputPrimitive } from '@base-ui/react/input';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/** Current shadcn Base UI input primitive. */
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
    return (
        <InputPrimitive
            type={type}
            data-slot="input"
            className={cn(
                'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
                className,
            )}
            {...props}
        />
    );
}
