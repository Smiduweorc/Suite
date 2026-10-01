<script setup lang="ts">
import { computed, onMounted } from "vue";
import AdminPanel from "./components/AdminPanel.vue";
import AuthPanel from "./components/AuthPanel.vue";
import FeedPanel from "./components/FeedPanel.vue";
import PostsPanel from "./components/PostsPanel.vue";
import { useAsync } from "./composables/useAsync";
import { useAuth } from "./composables/useAuth";
import { useHealth } from "./composables/useHealth";

const { user, ready, load, logout } = useAuth();
const { status, check } = useHealth();
const { busy: signingOut, error: signOutError, run } = useAsync("Could not sign out");

const isAdmin = computed(() => user.value?.role === "admin");

onMounted(async () => {
	// Until this settles render neither the login form nor the app, or a signed-in user
	// gets a flash of "please sign in".
	await load();

	await check();
});
</script>

<template>
	<main>
		<header>
			<div>
				<h1>Suite</h1>
				<p>
					The Smiduweorc libraries, together: lacewing, phasmid, Repletes, firefly and
					mycocepurus-smithii.
				</p>
				<p class="status">backend: {{ status }}</p>
			</div>

			<div v-if="user" class="session">
				<span>
					{{ user.name }}
					<span class="role">{{ user.role }}</span>
				</span>
				<button type="button" :disabled="signingOut" @click="run(logout)">Sign out</button>
				<p v-if="signOutError" class="error" role="alert">{{ signOutError }}</p>
			</div>
		</header>

		<template v-if="ready">
			<AuthPanel v-if="!user" />

			<AdminPanel v-if="isAdmin" />

			<!-- Keyed on the user: what you may see changed, so rebuild and reload. -->
			<PostsPanel :key="user?.id ?? 'anonymous'" />

			<FeedPanel />
		</template>
	</main>
</template>

<style scoped>
main {
	max-width: 42rem;
	margin: 0 auto;
	padding: 3rem 1.5rem;
	display: grid;
	gap: 2rem;
}

header {
	display: flex;
	justify-content: space-between;
	align-items: flex-start;
	gap: 1rem;
}

h1 {
	margin: 0;
}

header p {
	margin: 0.25rem 0 0;
	color: var(--muted);
}

.status {
	font-family: ui-monospace, monospace;
	font-size: 0.85rem;
}

.session {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	white-space: nowrap;
}

.error {
	margin: 0;
	color: var(--danger);
}

.role {
	margin-left: 0.25rem;
	padding: 0.1rem 0.45rem;
	border-radius: 999px;
	background: var(--border);
	font-size: 0.75rem;
}
</style>
