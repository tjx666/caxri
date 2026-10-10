import type { TerminalRecord, TerminalSurface } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import { MessageSquareText, SquareTerminal } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import { useCommandShortcut } from '../../lib/keybindings';
import { switchTerminalSurfaceTo } from './terminal-surface-commands';

const SURFACES = [
    { surface: 'pty', label: 'Terminal', Icon: SquareTerminal },
    { surface: 'chat', label: 'Chat', Icon: MessageSquareText },
] as const satisfies ReadonlyArray<{ surface: TerminalSurface; label: string; Icon: LucideIcon }>;

/**
 * The tab rail's Terminal | Chat switch for the active Chat-capable Agent Terminal. Pressing the other segment reopens
 * the Agent there through the same request, running-turn confirmation, and shortcut as the tab menu's "Open as ..."
 * entry; the segment that is already showing does nothing.
 */
export function AgentSurfaceToggle({ terminal }: { terminal: TerminalRecord }) {
    const shortcut = useCommandShortcut('terminal.switchAgentSurface');
    const current: TerminalSurface = terminal.surface ?? 'pty';
    return (
        <ToggleGroup<TerminalSurface>
            aria-label="Agent view"
            className="agent-surface-toggle gap-0.5 rounded border border-border p-0.5"
            value={[current]}
            onValueChange={(next) => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, the switch reports its own errors
                if (next[0]) void switchTerminalSurfaceTo(terminal, next[0]);
            }}
        >
            {SURFACES.map(({ surface, label, Icon }) => {
                const isCurrent = surface === current;
                return (
                    <Tooltip
                        key={surface}
                        content={isCurrent ? label : `Open as ${label}`}
                        shortcut={isCurrent ? undefined : shortcut}
                    >
                        <ToggleGroupItem
                            aria-label={label}
                            className="h-5 min-w-5 px-1"
                            value={surface}
                        >
                            <Icon aria-hidden="true" size={13} />
                        </ToggleGroupItem>
                    </Tooltip>
                );
            })}
        </ToggleGroup>
    );
}
