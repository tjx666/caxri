// The Android scenario spec's whole static import graph, loaded first as the guarded runner loads it.
import '../mobile-acceptance-scenarios.e2e';

import { expect, test } from '@playwright/test';

import { collectMobileAndroidCaseHandlers } from './mobile-android-case-registry';

test('loads every Android case handler after the Android scenario imports', async () => {
    expect((await collectMobileAndroidCaseHandlers()).size).toBeGreaterThan(0);
});
