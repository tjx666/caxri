import type { TerminalRecord, TerminalSurface } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { MessageSquareText, SquareTerminal } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import { useCommandShortcut } from '../../lib/keybindings';
import { switchTerminalSurfaceTo } from './terminal-surface-commands';
import { usePendingTerminalSurface } from './terminal-surface-switch-pending';

const SURFACES = [
    { surface: 'pty', label: 'Terminal', Icon: SquareTerminal },
    { surface: 'chat', label: 'Chat', Icon: MessageSquareText },
] as const satisfies ReadonlyArray<{ surface: TerminalSurface; label: string; Icon: LucideIcon }>;

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
 * The Server answers only after the provider restarted, which takes seconds. While that switch is pending (from any
 * entry point) both segments read as disabled and the target segment shows a spinner, so the press visibly registered.
 * They are `aria-disabled` rather than `disabled`, like the Chat's Stop button: Chromium evicts focus from a natively
 * disabled control, which would drop a keyboard user onto the document body mid-switch. The press itself is ignored
 * here and, from every other entry point, by the shared switch registry.
 */
export function AgentSurfaceToggle({ terminal }: { terminal: TerminalRecord }) {
    const shortcut = useCommandShortcut('terminal.switchAgentSurface');
    const current: TerminalSurface = terminal.surface ?? 'pty';
    const pendingSurface = usePendingTerminalSurface(terminal.id);
    const isSwitching = pendingSurface !== undefined;
    return (
        <ToggleGroup<TerminalSurface>
            aria-label="Open as Terminal or Chat"
            aria-busy={isSwitching}
            className="agent-surface-toggle gap-0.5 rounded border border-border p-0.5"
            value={[current]}
            onValueChange={(next) => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, the switch reports its own errors
                if (!isSwitching && next[0]) void switchTerminalSurfaceTo(terminal, next[0]);
            }}
        >
            {SURFACES.map(({ surface, label, Icon }) => {
                const isCurrent = surface === current;
                const isPending = surface === pendingSurface;
                return (
                    <Tooltip
                        key={surface}
                        content={
                            isPending
                                ? `Opening as ${label}…`
                                : isCurrent
                                  ? label
                                  : `Open as ${label}`
                        }
                        shortcut={isCurrent || isPending ? undefined : shortcut}
                    >
                        <ToggleGroupItem
                            aria-busy={isPending}
                            aria-disabled={isSwitching || undefined}
                            aria-label={label}
                            className="h-5 min-w-5 px-1 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 data-pressed:border-border data-pressed:text-[var(--agent-surface-toggle-pressed,var(--foreground))]"
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
