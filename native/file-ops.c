#define _DARWIN_C_SOURCE
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifdef __linux__
#include <linux/fs.h>
#include <sys/syscall.h>
#endif

#ifdef __APPLE__
#import <Foundation/Foundation.h>
#endif

enum ExitCode {
    EXIT_USAGE_ERROR = 64,
    EXIT_NOT_FOUND = 66,
    EXIT_UNAVAILABLE = 69,
    EXIT_IO_ERROR = 74,
    EXIT_CONFLICT = 73,
    EXIT_PATH_DENIED = 77,
};

typedef struct Identity {
    dev_t device;
    ino_t inode;
} Identity;

static void fail_errno(void) {
    switch (errno) {
        case EEXIST:
        case ENOTEMPTY:
            exit(EXIT_CONFLICT);
        case ENOENT:
            exit(EXIT_NOT_FOUND);
        case EACCES:
        case EPERM:
        case ELOOP:
        case ENOTDIR:
            exit(EXIT_PATH_DENIED);
        default:
            exit(EXIT_IO_ERROR);
    }
}

static uint64_t parse_unsigned(const char *value) {
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0') exit(EXIT_USAGE_ERROR);
    return (uint64_t)parsed;
}

static Identity parse_identity(const char *device, const char *inode) {
    Identity identity = {
        .device = (dev_t)parse_unsigned(device),
        .inode = (ino_t)parse_unsigned(inode),
    };
    return identity;
}

static int same_identity(const struct stat *stats, Identity expected) {
    return stats->st_dev == expected.device && stats->st_ino == expected.inode;
}

static void verify_descriptor(int descriptor, Identity expected, int directory) {
    struct stat stats;
    if (fstat(descriptor, &stats) != 0) fail_errno();
    if ((expected.device != 0 || expected.inode != 0) && !same_identity(&stats, expected))
        exit(EXIT_CONFLICT);
    if (directory && !S_ISDIR(stats.st_mode)) exit(EXIT_PATH_DENIED);
}

static int valid_name(const char *name) {
    return name[0] != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 &&
           strchr(name, '/') == NULL;
}

/** Opens every directory component relative to an already verified Project root. */
static int open_directory_beneath(int root, const char *relative_path, Identity expected) {
    if (relative_path[0] == '/' || strstr(relative_path, "//") != NULL) exit(EXIT_PATH_DENIED);
    int current = dup(root);
    if (current < 0) fail_errno();
    if (strcmp(relative_path, ".") != 0 && relative_path[0] != '\0') {
        char *copy = strdup(relative_path);
        if (copy == NULL) exit(EXIT_IO_ERROR);
        char *cursor = copy;
        char *component;
        while ((component = strsep(&cursor, "/")) != NULL) {
            if (!valid_name(component)) {
                free(copy);
                close(current);
                exit(EXIT_PATH_DENIED);
            }
            int next = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (next < 0) {
                free(copy);
                close(current);
                fail_errno();
            }
            close(current);
            current = next;
        }
        free(copy);
    }
    verify_descriptor(current, expected, 1);
    return current;
}

static void split_parent(const char *relative_path, char **parent, char **name) {
    if (relative_path[0] == '/' || relative_path[0] == '\0') exit(EXIT_PATH_DENIED);
    char *copy = strdup(relative_path);
    if (copy == NULL) exit(EXIT_IO_ERROR);
    char *separator = strrchr(copy, '/');
    if (separator == NULL) {
        *parent = strdup(".");
        *name = copy;
    } else {
        *separator = '\0';
        *parent = strdup(copy[0] == '\0' ? "." : copy);
        *name = strdup(separator + 1);
        free(copy);
    }
    if (*parent == NULL || *name == NULL || !valid_name(*name)) exit(EXIT_PATH_DENIED);
}

static void verify_entry(int parent, const char *name, Identity expected, struct stat *stats) {
    if (fstatat(parent, name, stats, AT_SYMLINK_NOFOLLOW) != 0) fail_errno();
    if (!same_identity(stats, expected)) exit(EXIT_CONFLICT);
    if (!S_ISREG(stats->st_mode) && !S_ISDIR(stats->st_mode)) exit(EXIT_PATH_DENIED);
    /** A file-reference URL identifies an inode, so reject ambiguous regular-file hard links. */
    if (S_ISREG(stats->st_mode) && stats->st_nlink != 1) exit(EXIT_PATH_DENIED);
}

static int open_root(const char *path, Identity expected) {
    int descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) fail_errno();
    verify_descriptor(descriptor, expected, 1);
    return descriptor;
}

static void verify_not_descendant(int root, int target_directory, Identity source) {
    int current = dup(target_directory);
    if (current < 0) fail_errno();
    for (;;) {
        struct stat current_stats;
        if (fstat(current, &current_stats) != 0) fail_errno();
        if (same_identity(&current_stats, source)) exit(EXIT_CONFLICT);

        struct stat root_stats;
        if (fstat(root, &root_stats) != 0) fail_errno();
        if (current_stats.st_dev == root_stats.st_dev && current_stats.st_ino == root_stats.st_ino)
            break;

        int parent = openat(current, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (parent < 0) fail_errno();
        struct stat parent_stats;
        if (fstat(parent, &parent_stats) != 0) fail_errno();
        if (parent_stats.st_dev == current_stats.st_dev && parent_stats.st_ino == current_stats.st_ino)
            exit(EXIT_PATH_DENIED);
        close(current);
        current = parent;
    }
    close(current);
}

static void rename_exclusive(int source_parent, const char *source_name, int target_parent,
                             const char *target_name) {
#ifdef __APPLE__
    /**
     * `RENAME_EXCL` is the macOS primitive that closes the lstat-then-rename overwrite race.
     * @see https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/renamex_np.2.html
     */
    if (renameatx_np(source_parent, source_name, target_parent, target_name, RENAME_EXCL) != 0)
        fail_errno();
#elif defined(__linux__)
    if (syscall(SYS_renameat2, source_parent, source_name, target_parent, target_name,
                RENAME_NOREPLACE) != 0)
        fail_errno();
#else
    (void)source_parent;
    (void)source_name;
    (void)target_parent;
    (void)target_name;
    exit(EXIT_UNAVAILABLE);
#endif
}

#ifdef __APPLE__
static int open_verified_entry(int parent, const char *name, Identity expected) {
    int descriptor = openat(parent, name, O_EVTONLY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) fail_errno();
    verify_descriptor(descriptor, expected, 0);
    return descriptor;
}

/** Creates an identity-bound URL from an already verified descriptor, never from caller text. */
static NSURL *reference_url_for_descriptor(int descriptor, Identity expected) {
    char path[PATH_MAX];
    if (fcntl(descriptor, F_GETPATH, path) != 0) fail_errno();
    NSURL *path_url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    NSURL *reference_url = [path_url fileReferenceURL];
    NSURL *current_url = [reference_url filePathURL];
    struct stat current_stats;
    if (current_url == nil || lstat(current_url.fileSystemRepresentation, &current_stats) != 0 ||
        !same_identity(&current_stats, expected))
        exit(EXIT_CONFLICT);
    return reference_url;
}

static void fail_foundation(NSError *error) {
    if ([error.domain isEqualToString:NSPOSIXErrorDomain]) {
        errno = (int)error.code;
        fail_errno();
    }
    if ([error.domain isEqualToString:NSCocoaErrorDomain]) {
        switch (error.code) {
            case NSFileNoSuchFileError:
                exit(EXIT_NOT_FOUND);
            case NSFileWriteFileExistsError:
                exit(EXIT_CONFLICT);
            case NSFileReadNoPermissionError:
            case NSFileWriteNoPermissionError:
                exit(EXIT_PATH_DENIED);
            default:
                break;
        }
    }
    exit(EXIT_IO_ERROR);
}

static Identity descriptor_identity(int descriptor) {
    struct stat stats;
    if (fstat(descriptor, &stats) != 0) fail_errno();
    return (Identity){.device = stats.st_dev, .inode = stats.st_ino};
}

static int create_staging_directory(int root, char name[64], Identity *identity) {
    unsigned char random_bytes[16];
    for (int attempt = 0; attempt < 16; attempt += 1) {
        arc4random_buf(random_bytes, sizeof(random_bytes));
        int offset = snprintf(name, 64, ".caxri-file-op-");
        for (size_t index = 0; index < sizeof(random_bytes); index += 1)
            offset += snprintf(name + offset, 64 - (size_t)offset, "%02x", random_bytes[index]);
        if (mkdirat(root, name, 0700) != 0) {
            if (errno == EEXIST) continue;
            fail_errno();
        }
        int descriptor = openat(root, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (descriptor < 0) fail_errno();
        *identity = descriptor_identity(descriptor);
        return descriptor;
    }
    exit(EXIT_CONFLICT);
}

static void close_staging_directory(int root, int staging, const char *name) {
    close(staging);
    /** `rmdir` can remove only an empty directory, so cleanup can never delete user file contents. */
    (void)unlinkat(root, name, AT_REMOVEDIR);
}

static void recover_staged_entry(int staging, int source_parent, const char *source_name,
                                 int saved_errno) {
    if (renameatx_np(staging, "entry", source_parent, source_name, RENAME_EXCL) == 0) return;
    if (errno != EEXIST) exit(EXIT_IO_ERROR);

    unsigned char random_bytes[16];
    char recovery_name[64];
    for (int attempt = 0; attempt < 16; attempt += 1) {
        arc4random_buf(random_bytes, sizeof(random_bytes));
        int offset = snprintf(recovery_name, sizeof(recovery_name), ".caxri-recovered-");
        for (size_t index = 0; index < sizeof(random_bytes); index += 1)
            offset += snprintf(recovery_name + offset, sizeof(recovery_name) - (size_t)offset,
                               "%02x", random_bytes[index]);
        if (renameatx_np(staging, "entry", source_parent, recovery_name, RENAME_EXCL) == 0) {
            dprintf(STDERR_FILENO, "RECOVERED:%s\n", recovery_name);
            errno = saved_errno;
            return;
        }
        if (errno != EEXIST) exit(EXIT_IO_ERROR);
    }
    exit(EXIT_IO_ERROR);
}

static void wait_for_test_continue(const char *ready_path, const char *continue_path) {
    if (ready_path == NULL || continue_path == NULL) return;
    int ready = open(ready_path, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
    if (ready < 0) fail_errno();
    close(ready);
    for (int attempt = 0; attempt < 5000; attempt += 1) {
        if (access(continue_path, F_OK) == 0) return;
        if (errno != ENOENT) fail_errno();
        usleep(1000);
    }
    exit(EXIT_IO_ERROR);
}

/**
 * Foundation first moves the verified file-reference URL into an unpredictable staging directory,
 * binding the operation to the opened inode. `RENAME_EXCL` then publishes it without overwriting a
 * target that appeared concurrently. A failed publish restores the source or preserves it under an
 * explicit recovery name when another process has also reclaimed the source pathname.
 * @see https://developer.apple.com/documentation/foundation/nsurl/filereferenceurl
 */
static void move_identity_bound(int root, int source_parent, const char *source_name, Identity source,
                                int target_parent, Identity target, const char *target_name,
                                int source_is_directory, const char *test_ready_path,
                                const char *test_continue_path) {
    int source_descriptor = open_verified_entry(source_parent, source_name, source);
    verify_descriptor(target_parent, target, 1);
    struct stat target_stats;
    if (fstatat(target_parent, target_name, &target_stats, AT_SYMLINK_NOFOLLOW) == 0)
        exit(EXIT_CONFLICT);
    if (errno != ENOENT) fail_errno();
    char staging_name[64];
    Identity staging_identity;
    int staging = create_staging_directory(root, staging_name, &staging_identity);
    @autoreleasepool {
        NSURL *source_url = reference_url_for_descriptor(source_descriptor, source);
        NSURL *staging_url = reference_url_for_descriptor(staging, staging_identity);
        NSURL *staged_entry_url = [staging_url URLByAppendingPathComponent:@"entry"
                                                               isDirectory:source_is_directory];
        wait_for_test_continue(test_ready_path, test_continue_path);
        NSError *error = nil;
        if (![[NSFileManager defaultManager] moveItemAtURL:source_url
                                                    toURL:staged_entry_url
                                                    error:&error]) {
            close_staging_directory(root, staging, staging_name);
            fail_foundation(error);
        }
        struct stat staged_stats;
        verify_entry(staging, "entry", source, &staged_stats);
        if (renameatx_np(staging, "entry", target_parent, target_name, RENAME_EXCL) != 0) {
            int saved_errno = errno;
            recover_staged_entry(staging, source_parent, source_name, saved_errno);
            close_staging_directory(root, staging, staging_name);
            errno = saved_errno;
            fail_errno();
        }
        struct stat published_stats;
        verify_entry(target_parent, target_name, source, &published_stats);
    }
    close_staging_directory(root, staging, staging_name);
    close(source_descriptor);
}
#endif

static int create_file(int argc, char **argv) {
    if (argc != 9 || !valid_name(argv[8])) return EXIT_USAGE_ERROR;
    int root = open_root(argv[2], parse_identity(argv[3], argv[4]));
    int directory = open_directory_beneath(root, argv[5], parse_identity(argv[6], argv[7]));
    int file = openat(directory, argv[8], O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC,
                      0666);
    if (file < 0) fail_errno();
    close(file);
    close(directory);
    close(root);
    return 0;
}

static int move_entry(int argc, char **argv, int test_mode) {
    if ((!test_mode && argc != 12) || (test_mode && argc != 14) || !valid_name(argv[11]))
        return EXIT_USAGE_ERROR;
    int root = open_root(argv[2], parse_identity(argv[3], argv[4]));
    char *source_parent_path;
    char *source_name;
    split_parent(argv[5], &source_parent_path, &source_name);
    int source_parent = open_directory_beneath(
        root, source_parent_path, (Identity){.device = 0, .inode = 0});
    struct stat source_stats;
    Identity source_identity = parse_identity(argv[6], argv[7]);
    verify_entry(source_parent, source_name, source_identity, &source_stats);
    int target_parent = open_directory_beneath(root, argv[8], parse_identity(argv[9], argv[10]));
    if (S_ISDIR(source_stats.st_mode)) verify_not_descendant(root, target_parent, source_identity);

#ifdef __APPLE__
    move_identity_bound(root, source_parent, source_name, source_identity, target_parent,
                        parse_identity(argv[9], argv[10]), argv[11], S_ISDIR(source_stats.st_mode),
                        test_mode ? argv[12] : NULL, test_mode ? argv[13] : NULL);
#else
    (void)test_mode;
    struct stat target_stats;
    if (fstatat(target_parent, argv[11], &target_stats, AT_SYMLINK_NOFOLLOW) == 0) {
        if (!same_identity(&target_stats, source_identity)) exit(EXIT_CONFLICT);
        if (renameat(source_parent, source_name, target_parent, argv[11]) != 0) fail_errno();
    } else {
        if (errno != ENOENT) fail_errno();
        rename_exclusive(source_parent, source_name, target_parent, argv[11]);
    }
#endif
    free(source_parent_path);
    free(source_name);
    close(target_parent);
    close(source_parent);
    close(root);
    return 0;
}

#ifdef __APPLE__
static int trash_entry(int root, int source_parent, const char *source_name, Identity source) {
    (void)root;
    int descriptor = open_verified_entry(source_parent, source_name, source);

    @autoreleasepool {
        /**
         * A file-reference URL follows the verified inode if its pathname changes before Trash.
         * @see https://developer.apple.com/documentation/foundation/nsurl/filereferenceurl
         */
        NSURL *reference_url = reference_url_for_descriptor(descriptor, source);
        NSError *error = nil;
        if (![[NSFileManager defaultManager] trashItemAtURL:reference_url
                                          resultingItemURL:nil
                                                     error:&error])
            fail_foundation(error);
    }
    close(descriptor);
    return 0;
}
#endif

static int trash_test_entry(int source_parent, const char *source_name) {
    size_t length = strlen(source_name) + strlen(".trashed") + 1;
    char *target_name = malloc(length);
    if (target_name == NULL) exit(EXIT_IO_ERROR);
    snprintf(target_name, length, "%s.trashed", source_name);
    rename_exclusive(source_parent, source_name, source_parent, target_name);
    free(target_name);
    return 0;
}

static int trash(int argc, char **argv, int test_mode) {
    if (argc != 8) return EXIT_USAGE_ERROR;
    int root = open_root(argv[2], parse_identity(argv[3], argv[4]));
    char *source_parent_path;
    char *source_name;
    split_parent(argv[5], &source_parent_path, &source_name);
    int source_parent = open_directory_beneath(
        root, source_parent_path, (Identity){.device = 0, .inode = 0});
    Identity source_identity = parse_identity(argv[6], argv[7]);
    struct stat source_stats;
    verify_entry(source_parent, source_name, source_identity, &source_stats);
    int result;
    if (test_mode) {
        result = trash_test_entry(source_parent, source_name);
    } else {
#ifdef __APPLE__
        result = trash_entry(root, source_parent, source_name, source_identity);
#else
        result = EXIT_UNAVAILABLE;
#endif
    }
    free(source_parent_path);
    free(source_name);
    close(source_parent);
    close(root);
    return result;
}

int main(int argc, char **argv) {
    if (argc < 2) return EXIT_USAGE_ERROR;
    if (strcmp(argv[1], "create") == 0) return create_file(argc, argv);
    if (strcmp(argv[1], "move") == 0) return move_entry(argc, argv, 0);
    if (strcmp(argv[1], "move-test") == 0) return move_entry(argc, argv, 1);
    if (strcmp(argv[1], "trash") == 0) return trash(argc, argv, 0);
    if (strcmp(argv[1], "trash-test") == 0) return trash(argc, argv, 1);
    return EXIT_USAGE_ERROR;
}
