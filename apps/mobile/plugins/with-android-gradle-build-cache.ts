import type { ConfigPlugin } from 'expo/config-plugins';
import { withGradleProperties } from 'expo/config-plugins';

type GradlePropertyItem =
    | { key: string; type: 'property'; value: string }
    | { type: 'comment'; value: string }
    | { type: 'empty' };

const BUILD_CACHE_PROPERTY = 'org.gradle.caching';

/**
 * Turns on Gradle's local build cache (`~/.gradle/caches/build-cache-1`), so a release build in a fresh worktree, or
 * after `expo prebuild --clean` dropped Gradle's execution history, restores cacheable task outputs another worktree
 * already produced instead of recompiling them. This stays in the plugin entrypoint because Expo transpiles that
 * TypeScript file in isolation.
 *
 * @see https://docs.gradle.org/current/userguide/build_cache.html
 */
export const enableGradleBuildCache = (properties: GradlePropertyItem[]): GradlePropertyItem[] => [
    ...properties.filter(
        (property) => property.type !== 'property' || property.key !== BUILD_CACHE_PROPERTY,
    ),
    { key: BUILD_CACHE_PROPERTY, type: 'property', value: 'true' },
];

const withAndroidGradleBuildCache: ConfigPlugin = (config) =>
    withGradleProperties(config, (config_) => {
        config_.modResults = enableGradleBuildCache(config_.modResults);
        return config_;
    });

export default withAndroidGradleBuildCache;
