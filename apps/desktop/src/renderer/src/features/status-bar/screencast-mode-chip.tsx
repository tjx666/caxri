import { Cast } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { useScreencastStore } from '../screencast/screencast';
import { StatusItem } from './status-item';

/**
 * Screencast Mode has no other persistent cue while active; see `screencast.ts`'s `toggleScreencastMode` for the paired
 * toast. Muted tokens keep it quiet per DESIGN.md's status bar redline (only degraded Server state earns a loud chip);
 * clicking replays the same toggle command a keybinding or the command palette would run.
 */
const screencastChipClassName = 'text-muted';

/**
 * The chip name alone implies recording safety it does not provide, so both the accessible name and the hover tooltip
 * spell out the actual behavior: Screencast Mode only overlays click ripples and a privacy-filtered keystroke badge
 * (see `screencast.ts`'s `describeScreencastKey`): it never hides or redacts anything already visible on screen, so
 * source code and Terminal output stay exactly as exposed as they would be without it.
 */
const SCREENCAST_CHIP_LABEL =
    'Screencast Mode is on — click to turn it off. It overlays click ripples and keystroke hints for recording; it does not hide or redact anything already on screen.';

export function ScreencastModeChip() {
    const isEnabled = useScreencastStore((state) => state.enabled);
    if (!isEnabled) return null;
    return (
        <StatusItem
            icon={<Cast />}
            ariaLabel={SCREENCAST_CHIP_LABEL}
            title={SCREENCAST_CHIP_LABEL}
            className={screencastChipClassName}
            onClick={() => executeCommand('developer.toggleScreencastMode')}
        >
            Screencast
        </StatusItem>
    );
}
