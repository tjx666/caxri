import type { CommanderRunState } from '@caxri/protocol';

export interface CommanderStatusChipCopy {
    /**
     * The chip's visible text, short enough for the crowded actions rail.
     */
    text: string;
    /**
     * Accessible name and tooltip: what the Commander is doing, and where to open or stop it.
     */
    description: string;
}

const LIVE_STATE_COPY: Record<Exclude<CommanderRunState, 'stopped'>, [string, string]> = {
    starting: ['starting', 'is starting'],
    working: ['working', 'is working on a turn'],
    waiting: ['needs input', 'is waiting for your answer in its window'],
    idle: ['idle', 'is idle'],
};

/**
 * The chip's copy while the Commander runs in the background, or undefined when it is stopped. A stopped Commander
 * shows nothing: View > Open Agent Commander already starts it, so a "stopped" chip would only add noise.
 */
export function commanderStatusChipCopy(
    state: CommanderRunState,
): CommanderStatusChipCopy | undefined {
    if (state === 'stopped') return undefined;
    const [text, detail] = LIVE_STATE_COPY[state];
    return {
        text: `Commander ${text}`,
        description: `Agent Commander ${detail}. It keeps running after its window closes. Click to open it; stop it from View > Stop Agent Commander.`,
    };
}

/**
 * The Inbox chip's copy for `count` open items, or undefined at zero: an empty Inbox holds no slot. The Inbox column is
 * titled "Needs you" in the Agent Commander window, so the chip reuses that phrase.
 */
export function commanderInboxChipCopy(count: number): CommanderStatusChipCopy | undefined {
    if (count <= 0) return undefined;
    const items = count === 1 ? '1 item' : `${count.toLocaleString('en-US')} items`;
    return {
        text: `${count.toLocaleString('en-US')} ${count === 1 ? 'needs' : 'need'} you`,
        description: `Open Agent Commander: ${items} in its Inbox ${count === 1 ? 'needs' : 'need'} your answer or merge.`,
    };
}
