/**
 * React Native adds the WebSocket endpoint as its default Origin. Accept that same-origin native request while
 * continuing to reject browser pages hosted elsewhere on the LAN.
 *
 * @see https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/websocket/WebSocketModule.kt
 */
export const isAllowedMobileOrigin = (
    origin: string | undefined,
    host: string | undefined,
): boolean => origin === undefined || (host !== undefined && origin === `http://${host}`);
