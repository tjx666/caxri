// The Android scenario spec's whole static import graph, loaded first as the guarded runner loads it.
import '../mobile-acceptance-scenarios.e2e';

import { expect, test } from '@playwright/test';

import { collectMobileChatCaseHandlers } from './mobile-chat-case-registry';

test('loads every Chat case handler after the Android scenario imports', async () => {
    expect((await collectMobileChatCaseHandlers()).size).toBeGreaterThan(0);
});
