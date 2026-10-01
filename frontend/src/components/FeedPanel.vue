<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useFeed } from "../composables/useFeed";

const { feed, busy, error, load } = useFeed();

onMounted(load);

const STATE_HINT = {
	miss: "just queried Postgres",
	fresh: "served from Redis",
	stale: "served from Redis, refreshing behind",
	retained: "Postgres failed - last good copy",
} as const;

const hint = computed(() => (feed.value ? STATE_HINT[feed.value.cache.state] : ""));
const age = computed(() => (feed.value ? (feed.value.cache.ageMs / 1000).toFixed(1) : "0"));
</script>

<template>
	<section class="feed">
		<header>
			<h2>Public feed</h2>
			<button type="button" :disabled="busy" @click="load">Reload</button>
		</header>

		<p v-if="feed" class="cache" data-test="cache">
			<span class="badge" :data-state="feed.cache.state">{{ feed.cache.state }}</span>
			{{ hint }}, {{ age }}s old
		</p>

		<p v-if="error" class="error" role="alert">{{ error }}</p>

		<ol v-if="feed && feed.posts.length">
			<li v-for="post in feed.posts" :key="post.id">
				<strong>{{ post.title }}</strong>
				<span>{{ post.body }}</span>
			</li>
		</ol>
		<p v-else-if="feed" class="empty">Nothing published yet.</p>

		<p class="note">
			Published posts only, so one cache entry serves everyone. Reload quickly to see
			<code>fresh</code>, wait 10s for <code>stale</code>; publishing a post clears it.
		</p>
	</section>
</template>

<style scoped>
.feed {
	display: grid;
	gap: 0.75rem;
	padding: 1.5rem;
	border: 1px solid var(--border);
	border-radius: 8px;
}

header {
	display: flex;
	justify-content: space-between;
	align-items: center;
}

h2 {
	margin: 0;
	font-size: 1.15rem;
}

.cache {
	margin: 0;
	font-size: 0.85rem;
	color: var(--muted);
}

.badge {
	margin-right: 0.35rem;
	padding: 0.1rem 0.5rem;
	border-radius: 999px;
	border: 1px solid var(--border);
	font-family: ui-monospace, monospace;
	color: var(--fg);
}

.badge[data-state="fresh"] {
	border-color: var(--accent);
	color: var(--accent);
}

.badge[data-state="stale"] {
	border-color: var(--warn);
	color: var(--warn);
}

.badge[data-state="retained"] {
	border-color: var(--danger);
	color: var(--danger);
}

ol {
	margin: 0;
	padding-left: 1.25rem;
	display: grid;
	gap: 0.35rem;
}

li span {
	margin-left: 0.5rem;
	color: var(--muted);
}

.empty,
.note,
.error {
	margin: 0;
	font-size: 0.85rem;
	color: var(--muted);
}

.error {
	color: var(--danger);
}
</style>
