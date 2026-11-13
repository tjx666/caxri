import type { ComponentProps } from 'react';

import { LoaderCircle } from 'lucide-react';

import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utilities';

/**
 * Shared loading indicator. `text-current` keeps call sites' color (e.g. `text-warning`, `text-muted`) and
 * `motion-reduce:animate-none` honors the reduced-motion contract every spinner in this repo must keep.
 *
 * The spin sits on an HTML wrapper, not the `<svg>`: Chromium runs a transform animation on an inline SVG root on the
 * main thread with a restyle every frame, while the same animation on an HTML element runs on the compositor (see
 * `RunningArc`). `className`, `style`, and the accessibility props describe the box, so they land on the wrapper; the
 * remaining props still reach the icon.
 */
export function Spinner({
    className,
    style,
    role = 'status',
    'aria-label': ariaLabel,
    'aria-hidden': ariaHidden,
    ...properties
}: ComponentProps<typeof LoaderCircle>) {
    const { t } = useTranslation();
    return (
        <span
            data-slot="spinner"
            role={role}
            aria-label={ariaLabel ?? t('core.spinner.loading')}
            aria-hidden={ariaHidden}
            className={cn(
                'inline-flex size-4 flex-none animate-spin text-current motion-reduce:animate-none',
                className,
            )}
            style={style}
        >
            <LoaderCircle aria-hidden="true" className="size-full" {...properties} />
        </span>
    );
}
