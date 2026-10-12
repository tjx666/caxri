import type { ReactNode } from 'react';
import { useState } from 'react';

import { formatTokens } from '@caxri/protocol';
import { ChevronRight } from 'lucide-react';

import { ReportCard } from '../../../components/report-card';
import { ShareBar } from '../../../components/share-bar';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { TokenRow } from './detail-rows';

/**
 * Rows a list shows before "Show all": enough to see what dominates without pushing the next card off screen.
 */
const COLLAPSED_ROWS = 8;

const rowGridClass =
    'grid grid-cols-[minmax(0,1fr)_minmax(3rem,6rem)_3.5rem] items-center gap-3 py-1 text-[12px]';

/**
 * A titled list of what occupies the context, heaviest first, each row with its share of the card's total. Rows with
 * children (an MCP server's tools) expand in place; long lists collapse to their heaviest rows.
 */
export function TokenListCard({
    title,
    caption,
    rows,
    total,
    empty,
    footer,
}: {
    title: string;
    caption?: ReactNode;
    rows: readonly TokenRow[];
    /**
     * What each row's share bar measures against; the card's own total, never its top row.
     */
    total: number;
    empty: string;
    footer?: ReactNode;
}) {
    const { t } = useTranslation();
    const [isShowingAll, setIsShowingAll] = useState(false);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const visible = isShowingAll ? rows : rows.slice(0, COLLAPSED_ROWS);
    const toggle = (id: string) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    };
    return (
        <ReportCard title={title} caption={caption}>
            {rows.length === 0 ? (
                <p className="m-0 text-[12px] text-muted">{empty}</p>
            ) : (
                <ul className="m-0 list-none p-0">
                    {visible.map((row) => (
                        <TokenListRow
                            key={row.id}
                            isExpanded={expanded.has(row.id)}
                            row={row}
                            total={total}
                            onToggle={() => toggle(row.id)}
                        />
                    ))}
                </ul>
            )}
            {rows.length > COLLAPSED_ROWS && (
                <button
                    type="button"
                    className="mt-2 cursor-pointer rounded-sm border-0 bg-transparent p-0 text-[11px] text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                    onClick={() => setIsShowingAll((current) => !current)}
                >
                    {isShowingAll
                        ? t('agentChat.contextPage.showFewer')
                        : t('agentChat.contextPage.showAll', { count: rows.length })}
                </button>
            )}
            {footer && <div className="mt-3 text-[11px] leading-[1.5] text-muted">{footer}</div>}
        </ReportCard>
    );
}

function TokenListRow({
    row,
    total,
    isExpanded,
    onToggle,
}: {
    row: TokenRow;
    total: number;
    isExpanded: boolean;
    onToggle: () => void;
}) {
    const hasChildren = Boolean(row.children?.length);
    const name = (
        <span
            className={cn(
                'truncate',
                row.isMono && 'font-mono text-[11px]',
                row.isMuted && 'text-muted',
            )}
        >
            {row.name}
        </span>
    );
    const label = (
        <span className="flex min-w-0 items-baseline gap-2">
            {row.tooltip ? (
                <Tooltip content={row.tooltip} anchorMode="cursor">
                    {name}
                </Tooltip>
            ) : (
                name
            )}
            {row.meta && (
                <span className="shrink-0 truncate text-[11px] text-muted">{row.meta}</span>
            )}
        </span>
    );
    return (
        <li>
            <div className={rowGridClass}>
                {hasChildren ? (
                    <button
                        type="button"
                        aria-expanded={isExpanded}
                        className="-ml-1 flex min-w-0 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent p-0 pl-1 text-left text-foreground hover:bg-[var(--selection)] focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                        onClick={onToggle}
                    >
                        <ChevronRight
                            aria-hidden="true"
                            className={cn(
                                'shrink-0 text-muted transition-transform duration-(--motion-expand)',
                                isExpanded && 'rotate-90',
                            )}
                            size={12}
                        />
                        {label}
                    </button>
                ) : (
                    label
                )}
                <ShareBar share={total > 0 ? row.tokens / total : 0} />
                <span className={cn('text-right tabular-nums', row.isMuted && 'text-muted')}>
                    {formatTokens(row.tokens)}
                </span>
            </div>
            {hasChildren && isExpanded && (
                <ul className="m-0 mb-1 ml-4 list-none border-l border-border p-0 pl-3">
                    {row.children?.map((child) => (
                        <li key={child.id} className={rowGridClass}>
                            <span className="flex min-w-0 items-baseline gap-2">
                                <span
                                    className={cn(
                                        'truncate font-mono text-[11px]',
                                        child.isMuted && 'text-muted',
                                    )}
                                >
                                    {child.name}
                                </span>
                                {child.meta && (
                                    <span className="shrink-0 text-[11px] text-muted">
                                        {child.meta}
                                    </span>
                                )}
                            </span>
                            <ShareBar share={total > 0 ? child.tokens / total : 0} />
                            <span
                                className={cn(
                                    'text-right tabular-nums',
                                    child.isMuted && 'text-muted',
                                )}
                            >
                                {formatTokens(child.tokens)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </li>
    );
}
