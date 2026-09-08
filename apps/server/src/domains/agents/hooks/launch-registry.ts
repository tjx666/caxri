import { randomUUID } from 'node:crypto';

import type { AgentProvider } from '@caxri/protocol';

interface HookLaunch {
    launchId: string;
    provider?: AgentProvider;
    token: string;
}

interface HookLaunchRegistryOptions {
    activate: (terminalId: string, launch: HookLaunch) => void;
    deactivate: (terminalId: string) => void;
    register: (terminalId: string, launchId: string, provider?: AgentProvider) => string;
    unregister: (token: string) => void;
}

/**
 * A Shell keeps observation-only hooks across manual Agent relaunches. Managed children override that context with a
 * separately revocable generation; their exit restores Shell observation without restoring Agent Endpoint authority.
 */
export class HookLaunchRegistry {
    private readonly shells = new Map<string, HookLaunch>();
    private readonly agents = new Map<string, HookLaunch>();

    constructor(private readonly options: HookLaunchRegistryOptions) {}

    shell(terminalId: string): HookLaunch {
        this.endShell(terminalId);
        this.endAgent(terminalId);
        const launchId = randomUUID();
        const launch = { launchId, token: this.options.register(terminalId, launchId) };
        this.shells.set(terminalId, launch);
        this.options.activate(terminalId, launch);
        return launch;
    }

    agent(terminalId: string, launchId: string, provider?: AgentProvider): HookLaunch {
        this.endAgent(terminalId);
        if (this.shells.has(terminalId)) this.options.deactivate(terminalId);
        const launch = {
            launchId,
            provider,
            token: this.options.register(terminalId, launchId, provider),
        };
        this.agents.set(terminalId, launch);
        this.options.activate(terminalId, launch);
        return launch;
    }

    endAgent(terminalId: string, expectedLaunchId?: string): void {
        const launch = this.agents.get(terminalId);
        if (!launch || (expectedLaunchId && launch.launchId !== expectedLaunchId)) return;
        this.agents.delete(terminalId);
        this.options.unregister(launch.token);
        this.options.deactivate(terminalId);
        const shell = this.shells.get(terminalId);
        if (shell) this.options.activate(terminalId, shell);
    }

    endShell(terminalId: string): void {
        const launch = this.shells.get(terminalId);
        if (!launch) return;
        this.shells.delete(terminalId);
        this.options.unregister(launch.token);
        if (!this.agents.has(terminalId)) this.options.deactivate(terminalId);
    }

    close(): void {
        for (const terminalId of this.shells.keys()) this.endShell(terminalId);
        for (const terminalId of this.agents.keys()) this.endAgent(terminalId);
    }
}
