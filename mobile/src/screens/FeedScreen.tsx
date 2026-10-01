import { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import { backendHealth, describe, type Feed, loadFeed } from "../api";
import { Badge, Card, colors, styles } from "../ui";

const STATE_COLOR = {
	miss: colors.muted,
	fresh: colors.accent,
	stale: colors.warn,
	retained: colors.error,
} as const;

const STATE_HINT = {
	miss: "just queried Postgres",
	fresh: "from Redis",
	stale: "from Redis, refreshing behind",
	retained: "Postgres is down - last good copy",
} as const;

/**
 * The public feed. Pull to refresh and watch the badge: Repletes on the server says where
 * each answer came from, and firefly on the device says what it thinks of the server.
 */
export function FeedScreen() {
	const [feed, setFeed] = useState<Feed | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const refresh = useCallback(async () => {
		setRefreshing(true);
		setError(null);

		try {
			setFeed(await loadFeed());
		} catch (cause) {
			setError(describe(cause));
		} finally {
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const health = backendHealth();

	return (
		<FlatList
			contentContainerStyle={styles.content}
			data={feed?.posts ?? []}
			keyExtractor={(post) => post.id}
			refreshControl={
				<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.fg} />
			}
			ListHeaderComponent={
				<View style={{ gap: 8 }}>
					<Text style={styles.h1}>Public feed</Text>
					{feed ? (
						<View style={styles.row}>
							<Badge label={feed.cache.state} color={STATE_COLOR[feed.cache.state]} />
							<Text style={styles.muted}>
								{STATE_HINT[feed.cache.state]},{" "}
								{(feed.cache.ageMs / 1000).toFixed(1)}s old
							</Text>
						</View>
					) : null}
					<Text style={styles.muted}>
						firefly: circuit {health.circuit}, {health.failures} recent failures
					</Text>
					{error ? <Text style={styles.error}>{error}</Text> : null}
				</View>
			}
			ListEmptyComponent={
				feed ? <Text style={styles.muted}>Nothing published yet.</Text> : null
			}
			renderItem={({ item }) => (
				<Card>
					<Text style={styles.h2}>{item.title}</Text>
					<Text style={styles.text}>{item.body}</Text>
					<Text style={styles.muted}>{new Date(item.createdAt).toLocaleString()}</Text>
				</Card>
			)}
		/>
	);
}
