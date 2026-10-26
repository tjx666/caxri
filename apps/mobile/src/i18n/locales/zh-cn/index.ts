import type { TranslatedNamespace } from '@caxri/protocol';
import { agentChatLabelsZhCN } from '@caxri/protocol';

import type { enResources } from '../en';
import { browser } from './browser';
import { changes } from './changes';
import { chat } from './chat';
import { common } from './common';
import { components } from './components';
import { connection } from './connection';
import { conversation } from './conversation';
import { hostStatus } from './host-status';
import { inbox } from './inbox';
import { pairing } from './pairing';
import { panels } from './panels';
import { projects } from './projects';
import { pullRequest } from './pull-request';
import { screens } from './screens';
import { sessions } from './sessions';
import { settings } from './settings';
import { terminal } from './terminal';
import { update } from './update';

export const zhCNResources: TranslatedNamespace<typeof enResources> = {
    ...agentChatLabelsZhCN,
    ...browser,
    ...changes,
    ...chat,
    ...common,
    ...components,
    ...connection,
    ...conversation,
    ...hostStatus,
    ...inbox,
    ...pairing,
    ...panels,
    ...projects,
    ...pullRequest,
    ...screens,
    ...sessions,
    ...settings,
    ...terminal,
    ...update,
};
