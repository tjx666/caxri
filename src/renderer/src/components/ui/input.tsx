import { Input as InputPrimitive } from '@base-ui/react/input';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/** Current shadcn Base UI input primitive. */
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
    return (
        <InputPrimitive
            type={type}
            data-slot="input"
            className={cn('input', className)}
            {...props}
        />
    );
}
