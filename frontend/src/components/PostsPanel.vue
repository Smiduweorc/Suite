<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAuth } from "../composables/useAuth";
import { usePosts } from "../composables/usePosts";

const { user } = useAuth();
const {
	posts,
	nextCursor,
	loading,
	loadError,
	busy,
	error,
	canEdit,
	load,
	loadMore,
	create,
	togglePublished,
	remove,
} = usePosts();

const title = ref("");
const body = ref("");

const signedIn = computed(() => user.value !== null);

async function submit() {
	// A failed create keeps what the user typed.
	if (await create(title.value, body.value)) {
		title.value = "";
		body.value = "";
	}
}

onMounted(load);
</script>

<template>
	<section class="panel">
		<form v-if="signedIn" class="composer" @submit.prevent="submit">
			<input v-model="title" placeholder="Title" aria-label="Title" required maxlength="200" />
			<textarea v-model="body" placeholder="Body" aria-label="Body" required rows="3" />
			<button type="submit" :disabled="busy">Create post</button>
		</form>

		<p v-else class="hint">Sign in to write a post. Drafts are visible only to you.</p>

		<p v-if="error" class="error" role="alert">{{ error }}</p>

		<p v-if="loading && !posts.length" class="hint" role="status">Loading posts...</p>

		<p v-if="!posts.length && !loading && !loadError" class="empty">
			No posts yet. Run <code>bun run db:seed</code>, or write one.
		</p>

		<ul class="posts">
			<li v-for="post in posts" :key="post.id">
				<div>
					<strong>{{ post.title }}</strong>
					<span :class="['badge', post.published ? 'live' : 'draft']">
						{{ post.published ? "published" : "draft" }}
					</span>
					<p>{{ post.body }}</p>
				</div>

				<div v-if="canEdit(post)" class="actions">
					<button type="button" :disabled="busy" @click="togglePublished(post)">
						{{ post.published ? "Unpublish" : "Publish" }}
					</button>
					<button type="button" :disabled="busy" @click="remove(post)">Delete</button>
				</div>
			</li>
		</ul>

		<!-- After the list, next to the button that failed: with pages loaded, the top of
		     the panel is out of sight. -->
		<div v-if="loadError" class="failed">
			<p class="error" role="alert">{{ loadError }}</p>
			<button v-if="!posts.length" type="button" :disabled="loading" @click="load">
				Try again
			</button>
		</div>

		<!-- Also the retry after a failed page: nothing moved, so it asks for the same one. -->
		<button
			v-if="nextCursor !== null"
			type="button"
			class="more"
			:disabled="loading"
			@click="loadMore"
		>
			{{ loading ? "Loading..." : "Load more" }}
		</button>
	</section>
</template>

<style scoped>
.panel {
	display: grid;
	gap: 1.5rem;
}

.composer {
	display: grid;
	gap: 0.75rem;
}

.posts {
	display: grid;
	gap: 0.75rem;
	padding: 0;
	list-style: none;
}

.posts li {
	display: flex;
	justify-content: space-between;
	gap: 1rem;
	padding: 1rem;
	border: 1px solid var(--border);
	border-radius: 8px;
}

.posts p {
	margin: 0.35rem 0 0;
	color: var(--muted);
}

.actions {
	display: flex;
	gap: 0.5rem;
	align-items: flex-start;
}

.badge {
	margin-left: 0.5rem;
	padding: 0.1rem 0.45rem;
	border-radius: 999px;
	font-size: 0.75rem;
}

.badge.live {
	background: #16653480;
}

.badge.draft {
	background: #78350f80;
}

.error {
	color: var(--danger);
}

.empty,
.hint {
	color: var(--muted);
}

.failed {
	display: flex;
	gap: 0.75rem;
	align-items: center;
}

.failed .error {
	margin: 0;
}

.more {
	justify-self: center;
}
</style>
