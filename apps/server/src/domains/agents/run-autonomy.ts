import type { AgentLaunchSettings, AgentProvider } from '@caxri/protocol';
import { hasProviderAutonomy, withProviderAutonomy } from '@caxri/protocol';

/**
 * Remembers whether each Terminal's latest Agent launch carried the provider's autonomy (YOLO) tokens, so a resume
 * restart can relaunch on the approval mode of the Agent Run it replaces instead of whatever the Settings switch says
 * now. A Reload is meant to continue the same conversation, and silently turning YOLO on or off for it would change
 * what the Agent may do without asking.
 *
 * Memory only, scoped to one Server Core generation: PTYs are never adopted across generations, so any live Agent Run
 * was launched (and recorded) by this one. Terminal IDs are never reused, so an entry left by a closed Terminal is
 * never read again; the map is bounded by the Agent Terminals launched during one generation.
 */
export class AgentRunAutonomy {
    readonly #byTerminal = new Map<string, boolean>();

    /**
     * The launch settings to start `terminalId`'s next Agent Run with, recorded as its latest launch. With
     * `shouldKeepPrevious`, the previous launch's autonomy tokens are forced present or absent on `configured` while
     * every other argument keeps following the current Settings; without a previous launch, `configured` applies as
     * is.
     */
    launch(
        terminalId: string,
        provider: AgentProvider,
        configured: AgentLaunchSettings,
        shouldKeepPrevious = false,
    ): AgentLaunchSettings {
        const previous = shouldKeepPrevious ? this.#byTerminal.get(terminalId) : undefined;
        const launch =
            previous === undefined
                ? configured
                : {
                      ...configured,
                      args: withProviderAutonomy(configured.args, provider, previous),
                  };
        this.#byTerminal.set(terminalId, hasProviderAutonomy(launch.args, provider));
        return launch;
    }
}
