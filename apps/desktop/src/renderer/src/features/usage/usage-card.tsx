import type { ReactNode } from 'react';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';

export function UsageCard({
    title,
    caption,
    className,
    children,
}: {
    title: string;
    caption?: ReactNode;
    className?: string;
    children: ReactNode;
}) {
    return (
        <section
            aria-label={title}
            className={cn('min-w-0 rounded-md border border-border bg-surface p-4', className)}
        >
            <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="m-0 text-[13px] font-semibold">{title}</h2>
                {caption && <span className="truncate text-[11px] text-muted">{caption}</span>}
            </div>
            {children}
        </section>
    );
}

export function StatTile({
    label,
    value,
    detail,
}: {
    label: string;
    value: string;
    detail?: ReactNode;
}) {
    return (
        <div className="min-w-0 rounded-md border border-border bg-surface px-4 py-3">
            <div className="truncate text-[11px] text-muted">{label}</div>
            <div className="mt-1 truncate text-[15px] font-semibold tabular-nums">{value}</div>
            {/* One line: a caption wrapped after a word or two (`$0 saved by / caching`) read as two facts. */}
            {detail && (
                <div className="mt-1 truncate text-[11px] leading-snug text-muted">{detail}</div>
            )}
        </div>
    );
}

/**
 * A horizontal share bar. The figure it encodes is always printed beside it, so the bar is decoration.
 */
export function ShareBar({ share }: { share: number }) {
    return (
        <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-sm bg-elevated">
            <div
                className="h-full rounded-sm bg-success"
                style={{ width: `${Math.max(share > 0 ? 2 : 0, Math.min(1, share) * 100)}%` }}
            />
        </div>
    );
}

export function ProviderLabel({ provider }: { provider: AgentProvider }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <AgentIdentityIcon identity={provider} size={14} />
            <span className="truncate">{agentProviderCatalog[provider].displayName}</span>
        </span>
    );
}

export const tableHeadClass = 'pb-2 text-left text-[11px] font-normal text-muted';
export const numericHeadClass = 'pb-2 text-right text-[11px] font-normal text-muted';
export const cellClass = 'truncate py-1 pr-3 text-[12px]';
export const numericCellClass = 'py-1 pl-3 text-right text-[12px] tabular-nums whitespace-nowrap';
