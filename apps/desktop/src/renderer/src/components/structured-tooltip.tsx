import type { ReactNode } from 'react';

import { openExternalUrl } from '../lib/external-link';
import { cn } from '../lib/utilities';
import { pushToast } from '../stores/toasts';

interface StructuredTooltipRow {
    label: string;
    value: ReactNode;
    /**
     * Paths and addresses: monospace, and allowed to break anywhere because they have no word boundaries to wait for.
     */
    isCode?: boolean;
}

/**
 * One sibling subject the tooltip names. `href` makes it a link; without one it stays plain text, so a reference the
 * provider never resolved is still listed without pretending it can be opened.
 */
interface StructuredTooltipLink {
    label: string;
    href?: string;
}

/**
 * The structured body of a multi-fact hover tooltip. Kept as data so each caller's wording stays unit-testable in its
 * own label module while this component alone decides the hierarchy.
 */
export interface StructuredTooltipData {
    /**
     * Small muted kind line above the title (`Pull request #12`), for a subject whose title alone does not say what it
     * is.
     */
    eyebrow?: string;
    title: ReactNode;
    rows?: readonly StructuredTooltipRow[];
    /**
     * Foreground supporting lines: state and verdict, one fact per line.
     */
    details?: readonly string[];
    /**
     * Muted prose: consequences, provenance, and other context that qualifies the title.
     */
    notes?: readonly string[];
    /**
     * A muted `label: a, b` line naming sibling subjects the trigger could not show. Its linked items are only
     * reachable when the host renders this inside a hover card rather than the non-interactive Tooltip, which closes as
     * soon as the pointer leaves the trigger.
     */
    links?: { label: string; items: readonly StructuredTooltipLink[] };
    /**
     * What clicking does, set apart at the bottom so it never reads as part of the state. A row with modifier gestures
     * lists one per line.
     */
    hint?: string | readonly string[];
}

/**
 * Status-bar chips and Source Control rows used to hand the shared Tooltip one `\n`-joined string, which rendered as an
 * unweighted block that wrapped mid-phrase at the popup's width. This lays the same content out as a title with
 * supporting rows instead.
 */
export function StructuredTooltip({
    details,
    eyebrow,
    hint,
    links,
    notes,
    rows,
    title,
}: StructuredTooltipData) {
    const hints = hint === undefined ? [] : typeof hint === 'string' ? [hint] : hint;
    return (
        <span className="flex min-w-0 flex-col gap-1 py-0.5 wrap-break-word whitespace-normal">
            {eyebrow && <span className="text-[11px] text-muted">{eyebrow}</span>}
            <span className="font-semibold">{title}</span>
            {rows && rows.length > 0 && (
                <span className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
                    {rows.map((row) => (
                        <span key={row.label} className="contents">
                            <span className="text-muted">{row.label}</span>
                            <span className={cn(row.isCode && 'font-mono wrap-anywhere')}>
                                {row.value}
                            </span>
                        </span>
                    ))}
                </span>
            )}
            {details?.map((detail) => (
                <span key={detail} className="text-[11px]">
                    {detail}
                </span>
            ))}
            {notes?.map((note) => (
                <span key={note} className="text-[11px] leading-[1.45] text-muted">
                    {note}
                </span>
            ))}
            {links && links.items.length > 0 && (
                <span className="text-[11px] leading-[1.45] text-muted">
                    {links.label}:{' '}
                    {links.items.map((item, index) => (
                        <span key={item.label}>
                            {index > 0 && ', '}
                            {item.href ? (
                                <StructuredTooltipAnchor href={item.href} label={item.label} />
                            ) : (
                                item.label
                            )}
                        </span>
                    ))}
                </span>
            )}
            {hints.length > 0 && (
                <span className="mt-0.5 flex flex-col text-[11px] text-muted">
                    {hints.map((line) => (
                        <span key={line}>{line}</span>
                    ))}
                </span>
            )}
        </span>
    );
}

function StructuredTooltipAnchor({ href, label }: { href: string; label: string }) {
    return (
        <a
            className="cursor-pointer text-accent no-underline underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-accent"
            href={href}
            rel="noreferrer"
            onClick={(event) => {
                // Main denies every window navigation, so the anchor is semantic only; `external.open` navigates.
                event.preventDefault();
                // eslint-disable-next-line no-void -- intentional floating-promise discard, openExternalUrl reports its own failure
                void openExternalUrl(href, (message) => pushToast('error', message));
            }}
        >
            {label}
        </a>
    );
}
