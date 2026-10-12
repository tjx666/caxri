import type { SettingsView } from '../../stores/dialogs';

/**
 * Requests that land on the ordinary settings list and are then answered by a `scrollToIndex` effect in
 * `settings-page.tsx`, rather than by switching to a dedicated tab or view.
 */
export const scrolledSettingsViews: ReadonlySet<SettingsView> = new Set([
    'hardware-acceleration',
    'remote-debugging',
    'notifications',
    'git-exclusions',
    'agent-suspension',
]);

/**
 * Views reached by scrolling one row into view, so one request carries the row id rather than one prop per row. Both
 * `argv.jsonc` boot flags land here (`settingTitleForArgvKey` in `argv-restart-notice.ts` already ties a boot flag to
 * its row through the binding type; this is the same convention on the navigation side), and so does the suspended
 * Terminal's Open Settings action, on the first of the Agent suspension settings.
 */
const FOCUSED_ROW_IDS: Partial<Record<SettingsView, string>> = {
    'hardware-acceleration': 'terminal.hardwareAcceleration',
    'remote-debugging': 'security.remoteDebugging',
    'agent-suspension': 'terminal.idleSuspension.enabled',
};

export function rowFocusRequest(request: {
    id: number;
    view: SettingsView;
}): { id: number; rowId: string } | undefined {
    const rowId = FOCUSED_ROW_IDS[request.view];
    return rowId ? { id: request.id, rowId } : undefined;
}
