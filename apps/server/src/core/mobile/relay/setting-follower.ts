import type { ServerDomainService } from '../../domain-service';
import type { MobileGateway } from '../gateway';

/**
 * Returns a trigger that re-reads `mobile.relayUrl` and applies it to the gateway, one read at a time so an older value
 * never lands after a newer one. A failed read keeps the current Relay route; the next settings change retries.
 */
export function createRelaySettingFollower(
    gateway: Pick<MobileGateway, 'configureRelay'>,
    domainService: Pick<ServerDomainService, 'request'>,
): () => void {
    let tail = Promise.resolve();
    return () => {
        const previous = tail;
        tail = (async (): Promise<void> => {
            await previous;
            try {
                const settings = await domainService.request('settings.get');
                await gateway.configureRelay(settings.value['mobile.relayUrl']);
            } catch {
                // The connector logs its own state; nothing here may carry the URL into a log.
            }
        })();
    };
}
