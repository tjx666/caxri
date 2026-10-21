import type { Translate } from '../../i18n';

/**
 * Hover text of an Open Session tab: the full label first, then one line per fact the tab itself cannot afford to show
 * (Project, Agent, worktree, status) and the `Cmd+N` chord that selects it. Lines with no value are omitted.
 */
export function sessionTabTooltip(
    input: {
        agentLabel: string;
        projectTitle?: string;
        /**
         * Short status sentence, for example `Working` or `Unread, finished`.
         */
        statusLabel?: string;
        suffix?: string;
        title: string;
        workingLocation?: string;
        /**
         * The digit of the `Cmd+<digit>` chord that selects the tab, when it has one.
         */
        shortcutDigit?: string;
    },
    t: Translate,
): string {
    const lines = [
        input.suffix ? `${input.title} (${input.suffix})` : input.title,
        input.projectTitle && t('sessionTabs.tooltip.project', { value: input.projectTitle }),
        t('sessionTabs.tooltip.agent', { value: input.agentLabel }),
        input.workingLocation &&
            t('sessionTabs.tooltip.worktree', { value: input.workingLocation }),
        input.statusLabel && t('sessionTabs.tooltip.status', { value: input.statusLabel }),
        input.shortcutDigit && t('sessionTabs.tooltip.shortcut', { key: input.shortcutDigit }),
    ];
    return lines.filter(Boolean).join('\n');
}
