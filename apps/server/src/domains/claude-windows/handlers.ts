import type { DomainHandlers } from '../domain-services';
import type { ClaudeWindowService } from './service';

export function createClaudeWindowHandlers(
    keeper: ClaudeWindowService,
): Pick<
    DomainHandlers,
    | 'claudeWindow.reportBackground'
    | 'claudeWindow.status'
    | 'claudeWindow.tick'
    | 'claudeWindow.update'
> {
    return {
        'claudeWindow.status': ({ refresh }) => keeper.status(refresh),
        'claudeWindow.update': (parameters) => keeper.update(parameters),
        'claudeWindow.tick': () => keeper.tick(),
        'claudeWindow.reportBackground': ({ state }) => {
            keeper.reportBackground(state);
            return { accepted: true };
        },
    };
}
