import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva('button', {
    variants: {
        variant: {
            default: 'button-default',
            secondary: 'button-secondary',
            ghost: 'button-ghost',
            danger: 'button-danger',
        },
        size: {
            default: 'button-md',
            sm: 'button-sm',
            icon: 'button-icon',
        },
    },
    defaultVariants: { variant: 'default', size: 'default' },
});

export function Button({
    className,
    variant,
    size,
    type = 'button',
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
    return (
        <button
            type={type}
            className={cn(buttonVariants({ variant, size }), className)}
            {...props}
        />
    );
}
