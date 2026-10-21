import { Platform } from 'react-native';

/**
 * The phone's monospace face. Android resolves the generic `monospace` family, but iOS has no such family name and
 * falls back to the proportional system font, so iOS names Menlo explicitly.
 */
export const MONOSPACE_FONT = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
