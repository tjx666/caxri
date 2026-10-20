import type { MobileCommanderInboxItem, MobileCommanderInboxListResult } from '@caxri/protocol';
import {
    commanderInboxKindLabel,
    commanderInboxMethods,
    commanderInboxReplyState,
    orderCommanderInboxItems,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { mobileErrorMessage } from '../connection/mobile-error-message';
import { sessionAgeLabel } from '../sessions/session-row-model';

export interface CommanderInboxCardModel {
    /**
     * "now" or "5m ago", measured against when the list was read rather than the render clock, so the label stays a
     * pure function of query data and refreshes with every read.
     */
    ageLabel: string;
    kindLabel: string;
    /**
     * `repo#number`, matching the Desktop card's pull request link.
     */
    pullRequestLabel?: string;
    replyState?: { isRead: boolean; label: string };
    /**
     * Shown on a pull request the Commander must re-verify, with Desktop's wording.
     */
    staleLabel?: string;
}

export const commanderInboxCardModel = (
    item: MobileCommanderInboxItem,
    readAt: number,
    t: Translate = translate,
): CommanderInboxCardModel => {
    const age = sessionAgeLabel(item.updatedAt, readAt, t);
    return {
        // Under a minute `sessionAgeLabel` already reads `now`, which takes no `ago`.
        ageLabel: readAt - item.updatedAt < 60_000 ? age : t('inbox.ageAgo', { age }),
        kindLabel: commanderInboxKindLabel(item.kind, t),
        ...(item.pullRequest && {
            pullRequestLabel: `${item.pullRequest.repo}#${item.pullRequest.number}`,
        }),
        ...(commanderInboxReplyState(item, t) && { replyState: commanderInboxReplyState(item, t) }),
        ...(item.staleReason === 'headMoved' && { staleLabel: t('inbox.changedSinceVerified') }),
    };
};

/**
 * Questions above pull requests, as on Desktop. The Server already sends them in this order; sorting again keeps the
 * screen correct regardless of how the reply was assembled.
 */
export const commanderInboxItems = (
    result: MobileCommanderInboxListResult | undefined,
): MobileCommanderInboxItem[] => orderCommanderInboxItems(result?.items ?? []);

/**
 * The reply to send, validated with the Server's own schema so Send disables exactly when the Server would reject it.
 * Null while the draft is blank or too long.
 */
export const commanderInboxReplyBody = (draft: string): string | null => {
    const parsed =
        commanderInboxMethods['commander.inbox.reply'].params.shape.body.safeParse(draft);
    return parsed.success ? parsed.data : null;
};

export type CommanderInboxScreenState =
    | { kind: 'items'; isStale: boolean; hasRefreshError: boolean }
    | { kind: 'empty'; isStale: boolean; hasRefreshError: boolean }
    | { kind: 'loading' }
    | { kind: 'offline' }
    | { kind: 'error' };

/**
 * What the screen shows. Data already read stays on screen when the phone goes offline or a refresh fails, with a
 * banner saying so; without data, offline and failure each get their own message.
 */
export const commanderInboxScreenState = ({
    hasData,
    isError,
    isObservable,
    itemCount,
}: {
    hasData: boolean;
    isError: boolean;
    isObservable: boolean;
    itemCount: number;
}): CommanderInboxScreenState => {
    if (hasData)
        return {
            kind: itemCount > 0 ? 'items' : 'empty',
            isStale: !isObservable,
            hasRefreshError: isObservable && isError,
        };
    if (!isObservable) return { kind: 'offline' };
    return isError ? { kind: 'error' } : { kind: 'loading' };
};

export const commanderInboxReplyErrorMessage = (error: unknown, t: Translate = translate): string =>
    mobileErrorMessage(error, t('inbox.replyFailed'), t);
