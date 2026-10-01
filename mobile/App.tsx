import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { describe, restoreSession, type Session, signOut } from "./src/api";
import { ComposeScreen } from "./src/screens/ComposeScreen";
import { FeedScreen } from "./src/screens/FeedScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { Button, colors, styles } from "./src/ui";

type Tab = "feed" | "compose";

export default function App() {
	const [ready, setReady] = useState(false);
	const [session, setSession] = useState<Session | null>(null);
	const [tab, setTab] = useState<Tab>("feed");
	// Bumped after a publish, so the feed remounts and asks again.
	const [feedVersion, setFeedVersion] = useState(0);
	const [signingOut, setSigningOut] = useState(false);
	// What the last sign-out could not do, shown on the sign-in screen until the next one.
	const [signOutNotice, setSignOutNotice] = useState<string | null>(null);

	useEffect(() => {
		restoreSession()
			.then(setSession)
			.finally(() => setReady(true));
	}, []);

	async function logOut() {
		setSigningOut(true);

		try {
			const outcome = await signOut();

			setSignOutNotice(
				outcome.revoked
					? null
					: `Signed out on this phone. The server could not be told (${describe(outcome.error)}), so this session stays valid there until it expires.`,
			);
		} catch (error) {
			setSignOutNotice(
				`Signed out, but the saved session could not be deleted (${describe(error)}). It may be back the next time the app opens.`,
			);
		} finally {
			setSigningOut(false);
			setSession(null);
		}
	}

	function signedIn(next: Session) {
		setSignOutNotice(null);
		setSession(next);
	}

	return (
		<SafeAreaProvider>
			<SafeAreaView style={styles.screen}>
				<StatusBar style="light" />

				{!ready ? (
					<ActivityIndicator color={colors.fg} style={{ marginTop: 80 }} />
				) : !session ? (
					<View style={{ flex: 1 }}>
						{signOutNotice ? (
							<Text style={[styles.warn, { paddingHorizontal: 20, paddingTop: 20 }]}>
								{signOutNotice}
							</Text>
						) : null}
						<LoginScreen onSignedIn={signedIn} />
					</View>
				) : (
					<View style={{ flex: 1 }}>
						<View
							style={[styles.row, { padding: 16, justifyContent: "space-between" }]}
						>
							<Text style={styles.text}>
								{session.user.name}{" "}
								<Text style={styles.muted}>{session.user.role}</Text>
							</Text>
							<Button
								title={signingOut ? "Signing out..." : "Sign out"}
								onPress={logOut}
								disabled={signingOut}
							/>
						</View>

						<View style={{ flex: 1 }}>
							{tab === "feed" ? (
								<FeedScreen key={feedVersion} />
							) : (
								<ComposeScreen onPublished={() => setFeedVersion((v) => v + 1)} />
							)}
						</View>

						<View style={[styles.row, { padding: 12, justifyContent: "center" }]}>
							<Button
								title="Feed"
								onPress={() => setTab("feed")}
								disabled={tab === "feed"}
							/>
							<Button
								title="Compose"
								onPress={() => setTab("compose")}
								disabled={tab === "compose"}
							/>
						</View>
					</View>
				)}
			</SafeAreaView>
		</SafeAreaProvider>
	);
}
