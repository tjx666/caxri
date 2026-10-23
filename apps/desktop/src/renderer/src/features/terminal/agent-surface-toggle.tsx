import type { TerminalRecord, TerminalSurface } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { MessageSquareText, SquareTerminal } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { switchTerminalSurfaceTo } from './terminal-surface-commands';
import { usePendingTerminalSurface } from './terminal-surface-switch-pending';

const SURFACES = [
    { surface: 'pty', Icon: SquareTerminal },
    { surface: 'chat', Icon: MessageSquareText },
] as const satisfies ReadonlyArray<{ surface: TerminalSurface; Icon: LucideIcon }>;

const SURFACE_COPY: Record<
    TerminalSurface,
    { label: TranslationKey; open: TranslationKey; opening: TranslationKey }
> = {
    chat: {
        label: 'terminal.surface.chat',
        open: 'terminal.surface.openAsChat',
        opening: 'terminal.surface.openingAsChat',
    },
    pty: {
        label: 'terminal.surface.terminal',
        open: 'terminal.surface.openAsTerminal',
        opening: 'terminal.surface.openingAsTerminal',
    },
};

/**
 * The tab rail's Terminal | Chat switch for the active Chat-capable Agent Terminal. Pressing the other segment reopens
 * the Agent there through the same request, running-turn confirmation, and shortcut as the tab menu's "Open as ..."
 * entry; the segment that is already showing does nothing.
 *
 * The group's accessible name, "Open as Terminal or Chat", is the `terminal.switchAgentSurface` title, so the palette,
 * the native menu, and this control read as one action.
 *
 * A host may dim the pressed segment's icon at rest by setting `--agent-surface-toggle-pressed` (the Workbench tab rail
 * does); without it the segment keeps the shared Toggle's `--foreground`.
 *
 * The pressed segment carries a border on top of the shared Toggle's pressed fill, scoped to this control: the shared
 * Toggle paints hover and pressed identically (`bg-elevated` + `text-foreground`), which in a two-segment switch made
 * the hovered other segment look already selected.
 *
 * Each segment is 24px wide and its hit area reaches 24px tall through an invisible `::after` that overflows the 20px
 * visual into the group's padding, so the 13px icons and the rail's height stay as they were while the target meets the
 * 24px minimum.
 *
 * The Server answers only after the provider restarted, which takes seconds. While that switch is pending (from any
 * entry point) both segments read as disabled and the target segment shows a spinner, so the press visibly registered.
 * They are `aria-disabled` rather than `disabled`, like the Chat's Stop button: Chromium evicts focus from a natively
 * disabled control, which would drop a keyboard user onto the document body mid-switch. The press itself is ignored
 * here and, from every other entry point, by the shared switch registry.
 */
export function AgentSurfaceToggle({ terminal }: { terminal: TerminalRecord }) {
    const { t } = useTranslation();
    const shortcut = useCommandShortcut('terminal.switchAgentSurface');
    const current: TerminalSurface = terminal.surface ?? 'pty';
    const pendingSurface = usePendingTerminalSurface(terminal.id);
    const isSwitching = pendingSurface !== undefined;
    return (
        <ToggleGroup<TerminalSurface>
            aria-label={t('terminal.surface.toggleLabel')}
            aria-busy={isSwitching}
            className="agent-surface-toggle gap-0.5 rounded border border-border p-0.5"
            value={[current]}
            onValueChange={(next) => {
                if (!isSwitching && next[0]) void switchTerminalSurfaceTo(terminal, next[0]);
            }}
        >
            {SURFACES.map(({ surface, Icon }) => {
                const copy = SURFACE_COPY[surface];
                const label = t(copy.label);
                const isCurrent = surface === current;
                const isPending = surface === pendingSurface;
                return (
                    <Tooltip
                        key={surface}
                        content={isPending ? t(copy.opening) : isCurrent ? label : t(copy.open)}
                        shortcut={isCurrent || isPending ? undefined : shortcut}
                    >
                        <ToggleGroupItem
                            aria-busy={isPending}
                            aria-disabled={isSwitching || undefined}
                            aria-label={label}
                            className="relative h-5 min-w-6 px-1 after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-[''] aria-disabled:cursor-not-allowed aria-disabled:opacity-50 data-pressed:border-border data-pressed:text-[var(--agent-surface-toggle-pressed,var(--foreground))]"
                            value={surface}
                        >
                            {isPending ? (
                                <Spinner aria-hidden="true" className="size-[13px]" />
                            ) : (
                                <Icon aria-hidden="true" size={13} />
                            )}
                        </ToggleGroupItem>
                    </Tooltip>
                );
            })}
        </ToggleGroup>
    );
}
