import type { ComponentProps } from 'react';

import { LoaderCircle } from 'lucide-react';

import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utilities';

/**
 * Shared loading indicator. `text-current` keeps call sites' color (e.g. `text-warning`, `text-muted`) and
 * `motion-reduce:animate-none` honors the reduced-motion contract every spinner in this repo must keep.
 */
export function Spinner({ className, ...properties }: ComponentProps<typeof LoaderCircle>) {
    const { t } = useTranslation();
    return (
        <LoaderCircle
            data-slot="spinner"
            role="status"
            aria-label={t('core.spinner.loading')}
            className={cn('size-4 animate-spin text-current motion-reduce:animate-none', className)}
            {...properties}
        />
    );
}
