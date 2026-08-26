import type { ComponentProps } from 'react';

import { LoaderCircle } from 'lucide-react';

import { cn } from '@/lib/utilities';

/**
 * Shared loading indicator. `text-current` keeps call sites' color (e.g. `text-warning`, `text-muted`) and
 * `motion-reduce:animate-none` honors the reduced-motion contract every spinner in this repo must keep.
 */
export function Spinner({ className, ...properties }: ComponentProps<typeof LoaderCircle>) {
    return (
        <LoaderCircle
            data-slot="spinner"
            role="status"
            aria-label="Loading"
            className={cn('size-4 animate-spin text-current motion-reduce:animate-none', className)}
            {...properties}
        />
    );
}
