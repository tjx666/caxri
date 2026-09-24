import { useCallback, useMemo, useRef } from 'react';
import { Platform, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import type { MobileTheme } from '../../theme/tokens';
import { TerminalLiveControls } from './terminal-live-controls';
import { TerminalLeaseBanner } from './terminal-live-status';
import { terminalViewStyles as styles } from './terminal-view-styles';
import { terminalWebviewDocument } from './terminal-webview-document';
import { useLiveTerminal } from './use-live-terminal';

interface TerminalLiveViewProperties {
    isConnected: boolean;
    isStopped: boolean;
    role: 'view' | 'reply' | 'control' | null;
    terminalId: string;
    theme: MobileTheme;
    visible: boolean;
}

export const TerminalLiveView = (properties: TerminalLiveViewProperties) => {
    if (Platform.OS === 'android') return <AndroidTerminalLiveView {...properties} />;
    return (
        <View style={[styles.root, styles.status]} testID="terminal-unavailable-platform">
            <Text style={[styles.statusText, { color: properties.theme.muted }]}>
                Live Terminal is available on Android in this build.
            </Text>
        </View>
    );
};

function AndroidTerminalLiveView({
    isConnected,
    isStopped,
    role,
    terminalId,
    theme,
    visible,
}: TerminalLiveViewProperties) {
    const webview = useRef<WebView>(null);
    const injectScript = useCallback((script: string): void => {
        webview.current?.injectJavaScript(script);
    }, []);
    const terminal = useLiveTerminal({
        injectScript,
        isConnected,
        isStopped,
        role,
        terminalId,
        visible,
    });
    const html = useMemo(() => terminalWebviewDocument(terminalId), [terminalId]);

    return (
        <View
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="terminal-live-view"
        >
            <TerminalLeaseBanner terminal={terminal} theme={theme} />
            <View style={styles.screen}>
                <WebView
                    ref={webview}
                    allowFileAccess={false}
                    allowUniversalAccessFromFileURLs={false}
                    cacheEnabled={false}
                    domStorageEnabled={false}
                    javaScriptCanOpenWindowsAutomatically={false}
                    mixedContentMode="never"
                    onMessage={(event) => terminal.onWebviewMessage(event.nativeEvent.data)}
                    onShouldStartLoadWithRequest={(request) =>
                        request.url === 'about:blank' || request.url === 'about:srcdoc'
                    }
                    originWhitelist={['*']}
                    setSupportMultipleWindows={false}
                    source={{ html }}
                    style={styles.webview}
                    testID="terminal-live-webview"
                    thirdPartyCookiesEnabled={false}
                />
            </View>
            <TerminalLiveControls role={role} terminal={terminal} theme={theme} />
        </View>
    );
}
