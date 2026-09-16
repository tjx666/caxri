import type { RemoteDebuggingState } from '@caxri/protocol';

export interface RemoteDebuggingChipCopy {
    /**
     * The chip's visible text, short enough to sit on the crowded actions rail.
     */
    text: string;
    /**
     * Accessible name and hover tooltip. The chip's two words cannot carry the consequence, so the long form states who
     * can connect and what they get, in the same words the Settings row uses.
     */
    description: string;
}

/**
 * The chip's copy for a debugging channel that is actually open, or undefined when nothing is listening.
 *
 * Caxri ships with the port on, so for most users this is the only place the product admits it. The sentence names the
 * consequence rather than the mechanism: "Chrome DevTools Protocol" tells a user nothing about what a connection can
 * do, and "can read every window and act as you" is the part that decides whether they want it on.
 */
export function remoteDebuggingChipCopy(
    state: RemoteDebuggingState,
): RemoteDebuggingChipCopy | undefined {
    if (state.transport === 'disabled') return undefined;
    const where =
        state.transport === 'pipe'
            ? 'through a pipe opened by whatever started Caxri'
            : state.port
              ? `on 127.0.0.1:${state.port}`
              : 'on a loopback port';
    return {
        text: state.transport === 'pipe' ? 'Debug pipe' : 'Debug port',
        description:
            `Caxri accepts debugging connections ${where}. Anything that connects can read every ` +
            'window and act as you; nothing on another machine can reach it. Click to open the setting.',
    };
}
