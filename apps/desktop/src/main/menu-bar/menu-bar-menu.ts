import type { SessionWorkAttention, SessionWorkSummary } from '@caxri/protocol';
import type { MenuItemConstructorOptions } from 'electron';

import type { MainTranslationKey } from '../locale';
import { translateMain as t } from '../locale';

/**
 * What the menu bar shows, read from the Server each time it changes.
 */
export interface MenuBarSnapshot {
    summary: SessionWorkSummary;
    /**
     * Whether Server Core holds the Mac awake right now (`host.status`).
     */
    isKeepingAwake: boolean;
    /**
     * `power.keepAwakeWhileAgentsWork`, which the menu toggles.
     */
    isKeepAwakeEnabled: boolean;
}

export interface MenuBarActions {
    openSession: (sessionId: string) => void;
    openWindow: () => void;
    quit: () => void;
    setKeepAwake: (isEnabled: boolean) => void;
}

const ATTENTION_LABEL: Record<SessionWorkAttention['kind'], MainTranslationKey> = {
    failed: 'desktop.menuBar.attentionFailed',
    result: 'desktop.menuBar.attentionResult',
    waiting: 'desktop.menuBar.attentionWaiting',
};

function plural(count: number, one: MainTranslationKey, other: MainTranslationKey): string {
    return t(count === 1 ? one : other, { count });
}

/**
 * Text beside the icon: how many Sessions need the user, or nothing. Attention first: a number only appears when there
 * is something to do, so a quiet night shows a bare icon.
 */
export function menuBarTitle(summary: SessionWorkSummary | undefined): string {
    return summary && summary.attentionCount > 0 ? String(summary.attentionCount) : '';
}

export function menuBarTooltip(summary: SessionWorkSummary | undefined): string {
    if (!summary) return t('desktop.menuBar.tooltip');
    return `${t('desktop.menuBar.tooltip')}: ${workingLabel(summary.working)}`;
}

function workingLabel(working: number): string {
    return working === 0
        ? t('desktop.menuBar.workingNone')
        : plural(working, 'desktop.menuBar.workingOne', 'desktop.menuBar.workingOther');
}

/**
 * The menu bar's menu. Status lines come first and are disabled (they inform, they do nothing), then the Sessions that
 * need the user, each opening Caxri on that Session, then the keep-awake switch and the app actions. Without a snapshot
 * (the Server is unreachable) only the app actions remain.
 */
export function buildMenuBarMenu(
    snapshot: MenuBarSnapshot | undefined,
    actions: MenuBarActions,
): MenuItemConstructorOptions[] {
    const appItems: MenuItemConstructorOptions[] = [
        { label: t('desktop.menuBar.open'), click: () => actions.openWindow() },
        { type: 'separator' },
        { label: t('desktop.menuBar.quit'), click: () => actions.quit() },
    ];
    if (!snapshot) return appItems;
    const { summary } = snapshot;
    const items: MenuItemConstructorOptions[] = [
        { label: workingLabel(summary.working), enabled: false },
    ];
    if (summary.usageWaiting > 0)
        items.push({
            label: plural(
                summary.usageWaiting,
                'desktop.menuBar.usageWaitingOne',
                'desktop.menuBar.usageWaitingOther',
            ),
            enabled: false,
        });
    if (snapshot.isKeepingAwake)
        items.push({ label: t('desktop.menuBar.keepingAwake'), enabled: false });
    if (summary.attentionCount > 0) {
        items.push({ type: 'separator' }, { label: t('desktop.menuBar.needsYou'), enabled: false });
        for (const attention of summary.attention)
            items.push({
                label: attention.title,
                sublabel: [attention.projectTitle, t(ATTENTION_LABEL[attention.kind])]
                    .filter(Boolean)
                    .join(' · '),
                click: () => actions.openSession(attention.sessionId),
            });
        const hidden = summary.attentionCount - summary.attention.length;
        if (hidden > 0)
            items.push({
                label: plural(hidden, 'desktop.menuBar.moreOne', 'desktop.menuBar.moreOther'),
                click: () => actions.openWindow(),
            });
    }
    items.push(
        { type: 'separator' },
        {
            label: t('desktop.menuBar.keepAwake'),
            type: 'checkbox',
            checked: snapshot.isKeepAwakeEnabled,
            click: () => actions.setKeepAwake(!snapshot.isKeepAwakeEnabled),
        },
        { type: 'separator' },
        ...appItems,
    );
    return items;
}
