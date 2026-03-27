import * as React from 'react';
import { Text, View, TextInput, Platform, KeyboardAvoidingView, ScrollView } from 'react-native';
import { RoundButton } from '@/components/RoundButton';
import { useAuth } from '@/auth/AuthContext';
import { localLogin, localRegister } from '@/auth/localAuth';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { getServerUrl } from '@/sync/serverConfig';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytesAsync } from 'expo-crypto';

export default React.memo(function LocalLoginScreen() {
    const auth = useAuth();
    const router = useRouter();
    const { theme } = useUnistyles();
    const [username, setUsername] = React.useState('');
    const [password, setPassword] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [mode, setMode] = React.useState<'login' | 'register'>('login');

    const handleSubmit = React.useCallback(async () => {
        if (!username.trim() || !password.trim()) {
            setError('Username and password are required');
            return;
        }
        if (mode === 'register' && password.length < 6) {
            setError('Password must be at least 6 characters');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const result = mode === 'login'
                ? await localLogin(username.trim(), password)
                : await localRegister(username.trim(), password);

            // Generate a local encryption secret for e2e session data
            const secret = await getRandomBytesAsync(32);
            await auth.login(result.token, encodeBase64(secret, 'base64url'));
        } catch (err: any) {
            const msg = err?.response?.data?.error || err?.message || 'Unknown error';
            if (mode === 'login' && err?.response?.status === 401) {
                setError('Invalid username or password');
            } else if (mode === 'register' && err?.response?.status === 409) {
                setError('Username already exists');
            } else {
                setError(msg);
            }
        } finally {
            setLoading(false);
        }
    }, [username, password, mode, auth]);

    return (
        <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
                contentContainerStyle={styles.container}
                keyboardShouldPersistTaps="handled"
            >
                <Text style={styles.title}>
                    {mode === 'login' ? 'Login' : 'Register'}
                </Text>
                <Text style={styles.serverInfo}>
                    Server: {getServerUrl()}
                </Text>

                {error && (
                    <View style={styles.errorContainer}>
                        <Text style={styles.errorText}>{error}</Text>
                    </View>
                )}

                <View style={styles.inputContainer}>
                    <Text style={styles.label}>Username</Text>
                    <TextInput
                        style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.border }]}
                        value={username}
                        onChangeText={setUsername}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder="Enter username"
                        placeholderTextColor={theme.colors.textSecondary}
                        editable={!loading}
                    />
                </View>

                <View style={styles.inputContainer}>
                    <Text style={styles.label}>Password</Text>
                    <TextInput
                        style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.border }]}
                        value={password}
                        onChangeText={setPassword}
                        secureTextEntry
                        placeholder={mode === 'register' ? 'Min 6 characters' : 'Enter password'}
                        placeholderTextColor={theme.colors.textSecondary}
                        editable={!loading}
                        onSubmitEditing={handleSubmit}
                    />
                </View>

                <View style={styles.buttonContainer}>
                    <RoundButton
                        title={loading ? 'Please wait...' : (mode === 'login' ? 'Login' : 'Register')}
                        action={handleSubmit}
                        disabled={loading}
                    />
                </View>

                <View style={styles.switchContainer}>
                    <Text style={styles.switchText}>
                        {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                    </Text>
                    <Text
                        style={styles.switchLink}
                        onPress={() => {
                            setMode(mode === 'login' ? 'register' : 'login');
                            setError(null);
                        }}
                    >
                        {mode === 'login' ? 'Register' : 'Login'}
                    </Text>
                </View>

                <View style={styles.backContainer}>
                    <Text
                        style={styles.switchLink}
                        onPress={() => router.back()}
                    >
                        Back
                    </Text>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    title: {
        fontSize: 28,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        marginBottom: 8,
    },
    serverInfo: {
        ...Typography.default(),
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 32,
    },
    errorContainer: {
        backgroundColor: theme.colors.destructive + '20',
        borderRadius: 8,
        padding: 12,
        marginBottom: 16,
        width: '100%',
        maxWidth: 320,
    },
    errorText: {
        ...Typography.default(),
        color: theme.colors.destructive,
        fontSize: 14,
        textAlign: 'center',
    },
    inputContainer: {
        width: '100%',
        maxWidth: 320,
        marginBottom: 16,
    },
    label: {
        ...Typography.default('medium'),
        fontSize: 14,
        color: theme.colors.text,
        marginBottom: 6,
    },
    input: {
        ...Typography.default(),
        fontSize: 16,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: theme.colors.card,
    },
    buttonContainer: {
        width: '100%',
        maxWidth: 320,
        marginTop: 8,
    },
    switchContainer: {
        flexDirection: 'row',
        marginTop: 24,
        alignItems: 'center',
    },
    switchText: {
        ...Typography.default(),
        color: theme.colors.textSecondary,
        fontSize: 14,
    },
    switchLink: {
        ...Typography.default('medium'),
        color: theme.colors.primary,
        fontSize: 14,
    },
    backContainer: {
        marginTop: 16,
    },
}));
