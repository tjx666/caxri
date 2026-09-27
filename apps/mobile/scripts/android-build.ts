#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

import { parseAndroidBuildRequest } from './android-environment';
import { resolveAndroidToolchain } from './android-toolchain';

const { expoPath, javaHome, mobileRoot, sdkRoot } = resolveAndroidToolchain();
const request = parseAndroidBuildRequest(process.argv.slice(2));
const result = spawnSync(
    request.buildOnly ? join(mobileRoot, 'android', 'gradlew') : expoPath,
    request.buildOnly
        ? [request.gradleTask, ...request.gradleArguments]
        : ['run:android', ...request.expoArguments],
    {
        cwd: request.buildOnly ? join(mobileRoot, 'android') : mobileRoot,
        env: {
            ...process.env,
            ANDROID_HOME: sdkRoot,
            ANDROID_SDK_ROOT: sdkRoot,
            EXPO_NO_GIT_STATUS: '1',
            JAVA_HOME: javaHome,
            PATH: `${join(javaHome, 'bin')}:${join(sdkRoot, 'platform-tools')}:${process.env.PATH ?? ''}`,
        },
        shell: false,
        stdio: 'inherit',
    },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
