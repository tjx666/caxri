import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { delegationNoticeRowLabel } from '../agent-chat-delegation-notice';

describe('delegationNoticeRowLabel', () => {
    it('joins the status word and the Session title into one spoken label', () => {
        expect(delegationNoticeRowLabel(translate, 'completed', 'Fix login')).toBe(
            `${translate('chat.delegationNotice.completed')}: Fix login`,
        );
    });
});
