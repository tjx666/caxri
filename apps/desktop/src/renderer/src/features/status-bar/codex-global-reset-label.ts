import type { AgentAvailability, CodexGlobalReset } from '@caxri/protocol';
import { CODEX_GLOBAL_RESET_SOURCE } from '@caxri/protocol';

import type { StructuredTooltipData } from '../../components/structured-tooltip';
import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { formatDateTime } from '../../lib/locale-format';
import { localizedDuration } from '../../lib/usage-format';

/**
 * Whether Caxri found the Codex CLI. The countdown only matters to someone who uses Codex.
 */
export function isCodexAvailable(availability: AgentAvailability): boolean {
    return availability.providers.some(({ kind, available }) => kind === 'codex' && available);
}

export interface CodexGlobalResetChipCopy {
    ariaLabel: string;
    label: string;
    postUrl: string;
    tooltip: StructuredTooltipData;
}

/**
 * The chip's wording, or undefined when there is nothing to count down to: no dated announcement, an unreadable
 * tracker, or a target time already reached. A reached target hides the chip rather than claiming the reset landed,
 * which only the account's own usage can confirm.
 */
export function codexGlobalResetChipCopy(
    reset: CodexGlobalReset | undefined,
    now: number,
    t: Translate = translate,
    formatTime: (at: number) => string = formatDateTime,
): CodexGlobalResetChipCopy | undefined {
    if (reset?.state !== 'scheduled' || reset.targetAt <= now) return undefined;
    const duration = localizedDuration(reset.targetAt - now, t);
    const isDeadline = reset.targetKind === 'deadline';
    const label = t(
        isDeadline
            ? 'statusBar.codexGlobalReset.labelWithin'
            : 'statusBar.codexGlobalReset.labelIn',
        { duration },
    );
    return {
        ariaLabel: t('statusBar.codexGlobalReset.ariaLabel', { label }),
        label,
        postUrl: reset.postUrl,
        tooltip: {
            eyebrow: t('statusBar.codexGlobalReset.eyebrow'),
            title: label,
            rows: [
                ...(reset.quote
                    ? [{ label: t('statusBar.codexGlobalReset.announcement'), value: reset.quote }]
                    : []),
                {
                    label: t(
                        isDeadline
                            ? 'statusBar.codexGlobalReset.targetDeadline'
                            : 'statusBar.codexGlobalReset.targetExact',
                    ),
                    value: formatTime(reset.targetAt),
                },
                {
                    label: t('statusBar.codexGlobalReset.announcedAt'),
                    value: formatTime(reset.announcedAt),
                },
            ],
            notes: [t('statusBar.codexGlobalReset.note')],
            links: {
                label: t('statusBar.codexGlobalReset.links'),
                items: [
                    { label: t('statusBar.codexGlobalReset.openPost'), href: reset.postUrl },
                    {
                        label: t('statusBar.codexGlobalReset.dataSource', {
                            source: CODEX_GLOBAL_RESET_SOURCE.name,
                        }),
                        href: CODEX_GLOBAL_RESET_SOURCE.url,
                    },
                ],
            },
            hint: t('statusBar.codexGlobalReset.clickToOpen'),
        },
    };
}
