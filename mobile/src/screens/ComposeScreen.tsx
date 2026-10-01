import { useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import { type Created, describe, publish } from "../api";
import { simulation } from "../transport";
import { Badge, Button, Card, colors, Field, styles } from "../ui";

/**
 * Turn on "lose the first response" and publish: firefly retries with the same
 * Idempotency-Key, the server replays the first response, and the card says "replayed".
 */
export function ComposeScreen({ onPublished }: { onPublished: () => void }) {
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [published, setPublished] = useState(true);
	const [flaky, setFlaky] = useState(simulation.dropFirstWriteResponse);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<Created | null>(null);
	const [error, setError] = useState<string | null>(null);

	function toggleFlaky(on: boolean) {
		simulation.dropFirstWriteResponse = on;
		setFlaky(on);
	}

	async function submit() {
		setBusy(true);
		setError(null);
		setResult(null);

		try {
			const created = await publish({ title, body, published });

			setResult(created);
			setTitle("");
			setBody("");
			if (created.post.published) onPublished();
		} catch (cause) {
			setError(describe(cause));
		} finally {
			setBusy(false);
		}
	}

	return (
		<ScrollView contentContainerStyle={styles.content}>
			<Text style={styles.h1}>New post</Text>

			<Field value={title} onChangeText={setTitle} placeholder="Title" maxLength={200} />
			<Field
				value={body}
				onChangeText={setBody}
				placeholder="Body"
				multiline
				style={[styles.input, { minHeight: 100, textAlignVertical: "top" }]}
			/>

			<View style={styles.row}>
				<Switch value={published} onValueChange={setPublished} />
				<Text style={styles.text}>Publish to the public feed</Text>
			</View>

			<View style={styles.row}>
				<Switch value={flaky} onValueChange={toggleFlaky} />
				<Text style={[styles.text, { flex: 1 }]}>
					Lose the first response (simulate a dropped connection)
				</Text>
			</View>

			<Button title={busy ? "Publishing..." : "Publish"} onPress={submit} disabled={busy} />

			{error ? <Text style={styles.error}>{error}</Text> : null}

			{result ? (
				<Card>
					<View style={styles.row}>
						<Badge
							label={result.replayed ? "replayed" : "first"}
							color={result.replayed ? colors.warn : colors.accent}
						/>
						<Text style={styles.text}>{result.post.title}</Text>
					</View>
					<Text style={styles.muted}>
						{result.replayed
							? "The first response was lost; the retry got it back from the idempotency ledger. One post was created."
							: "Created on the first attempt."}
					</Text>
					<Text style={[styles.muted, styles.mono]}>
						Idempotency-Key: {result.idempotencyKey}
					</Text>
				</Card>
			) : null}
		</ScrollView>
	);
}
