<script setup lang="ts">
import { emailKey } from "@bevd/backend/email";
import { computed, ref } from "vue";
import { useAsync } from "../composables/useAsync";
import { useAuth } from "../composables/useAuth";

const { login, register } = useAuth();

// The server deliberately says "Invalid email or password" for both cases; show it as is.
const { busy, error, run } = useAsync("Could not sign in");

const mode = ref<"login" | "register">("login");
const email = ref("");
const name = ref("");
const password = ref("");

/** The same function the server keys accounts on; shown only when it differs from the input. */
const canonical = computed(() => {
	const typed = email.value.trim();

	if (!typed.includes("@")) return null;

	const key = emailKey(typed);

	return key === typed.toLowerCase() ? null : key;
});

async function submit() {
	const ok = await run(async () => {
		if (mode.value === "login") {
			await login(email.value, password.value);
		} else {
			await register(email.value, name.value, password.value);
		}
	});

	if (ok) password.value = "";
}
</script>

<template>
	<section class="auth">
		<div class="tabs">
			<button
				type="button"
				:class="{ active: mode === 'login' }"
				@click="mode = 'login'"
			>
				Sign in
			</button>
			<button
				type="button"
				:class="{ active: mode === 'register' }"
				@click="mode = 'register'"
			>
				Register
			</button>
		</div>

		<form @submit.prevent="submit">
			<input
				v-model="email"
				type="email"
				placeholder="Email"
				aria-label="Email"
				required
				autocomplete="email"
			/>

			<p v-if="canonical" class="canonical" data-test="canonical">
				Same mailbox as <code>{{ canonical }}</code>
				<span>{{ mode === "login" ? "- signs in to that account" : "- one account per mailbox" }}</span>
			</p>

			<input
				v-if="mode === 'register'"
				v-model="name"
				placeholder="Name"
				aria-label="Name"
				required
				maxlength="100"
			/>

			<input
				v-model="password"
				type="password"
				placeholder="Password"
				aria-label="Password"
				required
				minlength="8"
				:autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
			/>

			<button type="submit" :disabled="busy">
				{{ mode === "login" ? "Sign in" : "Create account" }}
			</button>
		</form>

		<p v-if="error" class="error" role="alert">{{ error }}</p>

		<p class="hint">
			Seeded accounts: <code>alice@example.com</code> (admin) and
			<code>bob@example.com</code>, both <code>password123</code>.
		</p>
	</section>
</template>

<style scoped>
.auth {
	display: grid;
	gap: 1rem;
	padding: 1.5rem;
	border: 1px solid var(--border);
	border-radius: 8px;
}

.tabs {
	display: flex;
	gap: 0.5rem;
}

.tabs .active {
	border-color: var(--accent);
	color: var(--accent);
}

form {
	display: grid;
	gap: 0.75rem;
}

.error {
	margin: 0;
	color: var(--danger);
}

.canonical {
	margin: -0.35rem 0 0;
	font-size: 0.85rem;
	color: var(--accent);
}

.canonical span {
	color: var(--muted);
}

.hint {
	margin: 0;
	font-size: 0.85rem;
	color: var(--muted);
}
</style>
