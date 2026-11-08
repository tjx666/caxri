import type { ComponentType, ReactElement } from 'react';
import type { ViewProps } from 'react-native';

import MaskedViewClass from '@react-native-masked-view/masked-view';

/**
 * The package's declaration builds its class from `ReactNative.NativeMethods`, which React Native 0.88 no longer
 * exports, so TypeScript can no longer treat the class as a JSX component. 0.3.2 is the latest release and Expo SDK
 * 58's pin; the runtime component is unchanged, so only its props are restated here.
 * https://github.com/callstack/masked-view/blob/master/types/index.d.ts
 */
export const MaskedView = MaskedViewClass as unknown as ComponentType<
    ViewProps & { maskElement: ReactElement }
>;
