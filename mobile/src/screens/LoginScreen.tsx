import { normalizeEmail } from "phasmid";
import { useState } from "react";
import { Text, View } from "react-native";
import { describe, type Session, signIn } from "../api";
import { Button, Field, styles } from "../ui";

/**
 * The same rule the backend uses (backend/src/auth/email.ts), run on the device: phasmid
 * is pure ESM with no Node imports, so it works unchanged under Hermes. Shown only when the
 * canonical mailbox differs from what was typed - and either form signs in.
 */
function canonical(email: string): string | null {
	const typed = email.trim();

	if (!typed.includes("@")) return null;

	const key = normalizeEmail(typed, { defaultRule: { lowercaseLocal: true } });

	return key === typed.toLowerCase() ? null : key;
}

export function LoginScreen({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const mailbox = canonical(email);

	async function submit() {
		setBusy(true);
		setError(null);
	
		try {
			const result = await signIn(email, password);
			onSignedIn(result);
		} catch (cause) {
			setError(describe(cause) || "Fallback: Error caught");
		} finally {
			setBusy(false);
		}
	}
	

	return (
		<View style={styles.content}>
			<Text style={styles.h1}>Sign in</Text>

			<Field
				value={email}
				onChangeText={setEmail}
				placeholder="Email"
				autoCapitalize="none"
				autoComplete="email"
				keyboardType="email-address"
			/>
			{mailbox ? (
				<Text style={styles.muted}>
					Same mailbox as <Text style={styles.mono}>{mailbox}</Text> (phasmid)
				</Text>
			) : null}

			<Field
				value={password}
				onChangeText={setPassword}
				placeholder="Password"
				secureTextEntry
				autoComplete="current-password"
			/>

			<Button title={busy ? "Signing in..." : "Sign in"} onPress={submit} disabled={busy} />

			{error ? <Text style={styles.error}>{error}</Text> : null}

			<Text style={styles.muted}>
				Seeded: alice@example.com or bob@example.com, both password123.
			</Text>
		</View>
	);
}
