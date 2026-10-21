import { Directory, File, Paths } from 'expo-file-system';

import type { ReadCacheFiles } from './read-cache-store';
import { createReadCache } from './read-cache-store';

/**
 * Inside the app's private document directory, which Android and iOS exclude from other apps; the OS may still include
 * it in the user's own device backup.
 */
const directory = new Directory(Paths.document, 'read-cache');

const expoReadCacheFiles: ReadCacheFiles = {
    clear: () => {
        if (directory.exists) directory.delete();
    },
    list: () =>
        directory.exists
            ? directory
                  .list()
                  .filter((entry): entry is File => entry instanceof File)
                  .map((file) => ({ name: file.name, modifiedAt: file.lastModified ?? 0 }))
            : [],
    read: async (name) => {
        const file = new File(directory, name);
        return file.exists ? file.text() : null;
    },
    remove: (name) => {
        const file = new File(directory, name);
        if (file.exists) file.delete();
    },
    write: (name, text) => {
        directory.create({ idempotent: true, intermediates: true });
        // `write` resolves asynchronously since Expo SDK 58. `ReadCacheFiles.write` is synchronous so a `clear` can never
        // land before a write it already superseded.
        new File(directory, name).writeSync(text);
    },
};

export const expoReadCache = createReadCache(expoReadCacheFiles);
