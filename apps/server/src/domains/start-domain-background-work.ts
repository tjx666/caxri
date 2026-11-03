import type { WatchHub } from './watch';

/**
 * Starts the domains' background work once every domain is wired, in one place so the order stays explicit. The
 * scheduled-retry poll comes first and only here: a retry that is due at startup needs the live Endpoint generations
 * and the Chat services, and the recovery of unfinished claims already ran when the delegation service initialized.
 */
export function startDomainBackgroundWork(
    agentCommands: {
        delegationService: {
            retries: { startSchedules(hub: Pick<WatchHub, 'registerPoller'>): void };
        };
    },
    watchHub: Pick<WatchHub, 'registerPoller'>,
    ...services: ReadonlyArray<{ start(): void }>
): void {
    agentCommands.delegationService.retries.startSchedules(watchHub);
    for (const service of services) service.start();
}
