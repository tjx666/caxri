import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Platform, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import type { MobileTheme } from '../../theme/tokens';
import {
    TerminalControlBar,
    TerminalFloatingActions,
    TerminalKeyboardInput,
    TerminalStatusChip,
} from './terminal-live-controls';
import { terminalViewStyles as styles } from './terminal-view-styles';
import { terminalWebviewDocument } from './terminal-webview-document';
import { useLiveTerminal } from './use-live-terminal';
import { useTerminalKeyboard } from './use-terminal-keyboard';

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
    const keyboard = useTerminalKeyboard();
    const hasLeaseReference = useRef(false);
    const injectScript = useCallback((script: string): void => {
        webview.current?.injectJavaScript(script);
    }, []);
    const { focus } = keyboard;
    const onTap = useCallback((): void => {
        if (hasLeaseReference.current) focus();
    }, [focus]);
    const terminal = useLiveTerminal({
        injectScript,
        isConnected,
        isStopped,
        onTap,
        role,
        terminalId,
        visible,
    });
    useLayoutEffect(() => {
        hasLeaseReference.current = terminal.hasLease;
    }, [terminal.hasLease]);
    const html = useMemo(() => terminalWebviewDocument(terminalId), [terminalId]);
    const takeOver = async (): Promise<void> => {
        await terminal.takeOver();
        keyboard.focus();
    };

    return (
        <View
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="terminal-live-view"
        >
            <View style={styles.screen}>
                <WebView
                    key={terminal.webviewGeneration}
                    ref={webview}
                    allowFileAccess={false}
                    allowUniversalAccessFromFileURLs={false}
                    cacheEnabled={false}
                    domStorageEnabled={false}
                    javaScriptCanOpenWindowsAutomatically={false}
                    mixedContentMode="never"
                    onMessage={(event) => terminal.onWebviewMessage(event.nativeEvent.data)}
                    onRenderProcessGone={terminal.onWebviewTerminated}
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
                <TerminalStatusChip
                    isConnected={isConnected}
                    role={role}
                    terminal={terminal}
                    theme={theme}
                />
                <TerminalFloatingActions
                    onTakeOver={() => {
                        // eslint-disable-next-line no-void -- The hook reports takeover failures in the UI.
                        void takeOver();
                    }}
                    terminal={terminal}
                    theme={theme}
                />
            </View>
            {terminal.hasLease ? (
                <>
                    <TerminalKeyboardInput inputReference={keyboard.input} terminal={terminal} />
                    <TerminalControlBar
                        onToggleKeyboard={keyboard.toggle}
                        terminal={terminal}
                        theme={theme}
                    />
                </>
            ) : null}
        </View>
    );
}
