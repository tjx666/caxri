import type { ReactNode } from 'react';

import { Tooltip } from '../../components/ui/tooltip';
import { openExternalUrl } from '../../lib/external-link';
import { cn } from '../../lib/utilities';
import { pushToast } from '../../stores/toasts';

/**
 * The glyph is sized here rather than by each caller's `size` prop, so that `icon` can take any rendered element: a
 * Lucide component, a Linear workflow glyph, without every call site having to know which of the two status-bar heights
 * it is rendering into. CSS wins over an SVG's `width`/`height` attributes, and neither icon family scales its
 * `viewBox` with `size`, so the result is identical to the prop. 13px is the `base` type tier this item sits at;
 * DESIGN.md "Spacing and radius" records why the two bar glyph boxes are allowed to state it.
 */
export const statusItemClassName =
    'statusbar-item inline-flex h-5 min-w-0 items-center gap-[5px] overflow-hidden rounded border-0 bg-transparent px-[5px] text-foreground no-underline cursor-pointer hover:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--foreground)] [&>svg]:flex-none [&>svg]:size-[13px] [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap';

/**
 * Same hover-tooltip contract as `StatusInfo`, for the clickable status-bar entries.
 */
export function StatusItem({
    ariaLabel,
    children,
    className,
    href,
    icon,
    onClick,
    title,
}: {
    ariaLabel: string;
    children: ReactNode;
    className?: string;
    href?: string;
    icon: ReactNode;
    onClick?: () => void;
    title: ReactNode;
}) {
    const content = (
        <>
            {icon}
            <span>{children}</span>
        </>
    );
    return (
        <Tooltip content={title}>
            {href ? (
                <a
                    className={cn(statusItemClassName, className)}
                    href={href}
                    rel="noreferrer"
                    aria-label={ariaLabel}
                    onClick={(event) => {
                        // Main denies every `window.open`/target=_blank navigation, so this anchor
                        // is semantic only; the actual navigation goes through `external.open`.
                        event.preventDefault();
                        // eslint-disable-next-line no-void -- intentional floating-promise discard, openExternalUrl reports its own failure
                        void openExternalUrl(href, (message) => pushToast('error', message));
                    }}
                >
                    {content}
                </a>
            ) : (
                <button
                    type="button"
                    className={cn(statusItemClassName, className)}
                    aria-label={ariaLabel}
                    onClick={onClick}
                >
                    {content}
                </button>
            )}
        </Tooltip>
    );
}
