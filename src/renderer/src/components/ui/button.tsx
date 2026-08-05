import type { ButtonHTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'default' | 'sm' | 'icon';

const variantClassName: Record<ButtonVariant, string> = {
    default: 'button-default',
    secondary: 'button-secondary',
    ghost: 'button-ghost',
    danger: 'button-danger',
};

const sizeClassName: Record<ButtonSize, string> = {
    default: 'button-md',
    sm: 'button-sm',
    icon: 'button-icon',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
}

export function Button({
    className,
    variant = 'default',
    size = 'default',
    type = 'button',
    ...props
}: ButtonProps) {
    return (
        <button
            type={type}
            className={cn('button', variantClassName[variant], sizeClassName[size], className)}
            {...props}
        />
    );
}
