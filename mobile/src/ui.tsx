import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, type TextInputProps, View } from "react-native";

export const colors = {
	bg: "#0b0f17",
	fg: "#e6edf3",
	muted: "#8b949e",
	border: "#263041",
	accent: "#4ade80",
	warn: "#facc15",
	error: "#f87171",
};

export function Button({
	title,
	onPress,
	disabled,
}: {
	title: string;
	onPress: () => void;
	disabled?: boolean;
}) {
	return (
		<Pressable
			accessibilityRole="button"
			onPress={onPress}
			disabled={disabled}
			style={({ pressed }) => [
				styles.button,
				pressed && { borderColor: colors.accent },
				disabled && { opacity: 0.5 },
			]}
		>
			<Text style={styles.buttonText}>{title}</Text>
		</Pressable>
	);
}

export function Field(props: TextInputProps) {
	return <TextInput placeholderTextColor={colors.muted} style={styles.input} {...props} />;
}

export function Card({ children }: { children: ReactNode }) {
	return <View style={styles.card}>{children}</View>;
}

export function Badge({ label, color }: { label: string; color: string }) {
	return <Text style={[styles.badge, { borderColor: color, color }]}>{label}</Text>;
}

export const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: colors.bg },
	content: { padding: 20, gap: 14 },
	h1: { color: colors.fg, fontSize: 26, fontWeight: "700" },
	h2: { color: colors.fg, fontSize: 18, fontWeight: "600" },
	text: { color: colors.fg, fontSize: 15 },
	muted: { color: colors.muted, fontSize: 13 },
	error: { color: colors.error, fontSize: 14 },
	warn: { color: colors.warn, fontSize: 14 },
	mono: { fontFamily: "monospace" },
	row: { flexDirection: "row", alignItems: "center", gap: 10 },
	card: {
		gap: 6,
		padding: 14,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 8,
	},
	input: {
		color: colors.fg,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 6,
		paddingHorizontal: 12,
		paddingVertical: 10,
		fontSize: 15,
	},
	button: {
		alignItems: "center",
		paddingVertical: 10,
		paddingHorizontal: 14,
		borderWidth: 1,
		borderColor: colors.border,
		borderRadius: 6,
	},
	buttonText: { color: colors.fg, fontSize: 15, fontWeight: "500" },
	badge: {
		alignSelf: "flex-start",
		paddingHorizontal: 8,
		paddingVertical: 1,
		borderWidth: 1,
		borderRadius: 999,
		fontFamily: "monospace",
		fontSize: 12,
		overflow: "hidden",
	},
});
