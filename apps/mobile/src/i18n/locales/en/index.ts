import { agentChatLabelsEn } from '@caxri/protocol';

import { browser } from './browser';
import { changes } from './changes';
import { chat } from './chat';
import { common } from './common';
import { components } from './components';
import { connection } from './connection';
import { conversation } from './conversation';
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

/**
 * English is the source language: every namespace's keys and placeholders are defined here first.
 */
export const enResources = {
    ...agentChatLabelsEn,
    ...browser,
    ...changes,
    ...chat,
    ...common,
    ...components,
    ...connection,
    ...conversation,
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
