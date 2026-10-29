import type { TerminalRecord } from '@caxri/protocol';
import { Gauge } from 'lucide-react';

import { useClockTick } from '@/hooks/use-clock-tick';

import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { localizedLimitReset } from '../../lib/usage-format';

/**
 * The pane row telling a PTY Agent that its provider's account is at the weekly usage guard (issue #2608). It is
 * informational: Chats on the account are refused, but a running PTY is never interrupted and `--resume` is not
 * blocked, so the row only names the usage and the reset. It clears when Server Core drops `usageGuard` from the
 * record.
 */
export function TerminalUsageGuard({ terminal }: { terminal: TerminalRecord | undefined }) {
    const { t } = useTranslation();
    const now = useClockTick('minute');
    if (!terminal?.provider) return null;
    const guard = terminal.usageGuard;
    if (!guard) return null;
    const detail = t('terminal.usageGuard.detail', {
        reset: localizedLimitReset(guard.resetsAt, now, t),
    });
    return (
        <div
            aria-live="polite"
            className="flex min-w-0 flex-none basis-7 items-center gap-2 border-t border-border bg-[color-mix(in_srgb,var(--surface)_65%,var(--background))] px-2 text-[11px] text-muted"
            data-terminal-usage-guard=""
            role="status"
        >
            <Gauge aria-hidden className="size-3.5 flex-none text-warning" />
            <span className="flex-none text-warning">
                {t('terminal.usageGuard.headline', {
                    provider: resolveAgentIcon(terminal.provider).label,
                    percent: Math.floor(guard.usedPercent),
                })}
            </span>
            <Tooltip content={detail}>
                <span className="min-w-0 truncate">{detail}</span>
            </Tooltip>
        </div>
    );
}
