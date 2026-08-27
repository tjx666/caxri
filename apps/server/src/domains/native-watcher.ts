import process from 'node:process';

import type parcelWatcher from '@parcel/watcher';

/**
 * Native recursive backends avoid allocating one filesystem watcher per directory.
 */
export const NATIVE_WATCHER_BACKEND: parcelWatcher.BackendType =
    process.platform === 'darwin'
        ? 'fs-events'
        : process.platform === 'win32'
          ? 'windows'
          : 'inotify';
