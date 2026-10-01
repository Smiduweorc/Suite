import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../../composables/useAuth";
import PostsPanel from "../PostsPanel.vue";

const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

// Stands in for whoever is signed in. The tests set it before mounting.
const currentUser = { value: null as CurrentUser | null };

vi.mock("../../composables/useAuth", () => ({
	useAuth: () => ({ user: currentUser }),
}));

vi.mock("../../lib/trpc", () => ({
	trpc: {
		post: {
			list: { query: (...args: unknown[]) => list(...args) },
			create: { mutate: (...args: unknown[]) => create(...args) },
			update: { mutate: (...args: unknown[]) => update(...args) },
			delete: { mutate: (...args: unknown[]) => remove(...args) },
		},
	},
}));

// Timestamps are ISO strings, not Dates. tRPC serializes with plain JSON, so a Date the
// server returns arrives as a string - and the inferred client types say exactly that.
// (Add superjson as a transformer on both ends if you want real Dates back.)
const AT = "2026-01-01T00:00:00.000Z";

function post(overrides: Record<string, unknown> = {}) {
	return {
		id: "99999999-9999-4999-8999-999999999999",
		title: "Hello",
		body: "World",
		published: true,
		authorId: ALICE,
		createdAt: AT,
		updatedAt: AT,
		...overrides,
	};
}

function page(items: ReturnType<typeof post>[], nextCursor: string | null = null) {
	return { items, nextCursor };
}

/** A promise the test settles by hand, to look at the page while a request is in flight. */
function gate<T>() {
	let open!: (value: T) => void;
	let fail!: (error: Error) => void;
	const promise = new Promise<T>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});

	return { promise, open, fail };
}

const moreButton = (wrapper: ReturnType<typeof mount>) =>
	wrapper.findAll("button").find((button) => /Load more|Loading\.\.\./.test(button.text()));

function user(overrides: Record<string, unknown> = {}): CurrentUser {
	return {
		id: ALICE,
		email: "alice@example.com",
		name: "Alice",
		role: "user",
		createdAt: AT,
		updatedAt: AT,
		...overrides,
	} as CurrentUser;
}

describe("PostsPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUser.value = null;
		list.mockResolvedValue(page([post()]));
	});

	it("hides the composer from anonymous visitors", async () => {
		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(wrapper.find("form").exists()).toBe(false);
		expect(wrapper.text()).toContain("Sign in to write a post");
		expect(wrapper.find(".actions").exists()).toBe(false);
	});

	it("shows edit controls on your own post", async () => {
		currentUser.value = user();

		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(wrapper.find("form").exists()).toBe(true);
		expect(wrapper.find(".actions").exists()).toBe(true);
	});

	it("hides edit controls on someone else's post", async () => {
		currentUser.value = user({ id: BOB, name: "Bob", email: "bob@example.com" });

		const wrapper = mount(PostsPanel);
		await flushPromises();

		// Bob may write his own posts...
		expect(wrapper.find("form").exists()).toBe(true);
		// ...but not touch Alice's.
		expect(wrapper.find(".actions").exists()).toBe(false);
	});

	it("shows edit controls on anyone's post for an admin", async () => {
		currentUser.value = user({ id: BOB, name: "Root", role: "admin" });

		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(wrapper.find(".actions").exists()).toBe(true);
	});

	it("creates a post and puts it at the top", async () => {
		currentUser.value = user();
		create.mockResolvedValue(
			post({ id: "33333333-3333-4333-8333-333333333333", title: "Fresh" }),
		);

		const wrapper = mount(PostsPanel);
		await flushPromises();

		await wrapper.find("input").setValue("Fresh");
		await wrapper.find("textarea").setValue("Body");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		expect(create).toHaveBeenCalledWith({ title: "Fresh", body: "Body" });
		expect(wrapper.findAll("li strong").map((n) => n.text())).toEqual(["Fresh", "Hello"]);
	});

	it("surfaces a rejected mutation instead of swallowing it", async () => {
		currentUser.value = user();
		update.mockRejectedValue(new Error("That post belongs to someone else"));

		const wrapper = mount(PostsPanel);
		await flushPromises();

		await wrapper.find("li .actions button").trigger("click");
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe("That post belongs to someone else");
	});

	it("says the list failed to load, not that there are no posts", async () => {
		list.mockRejectedValue(new Error("Internal server error"));

		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe("Internal server error");
		expect(wrapper.find(".empty").exists()).toBe(false);
	});

	it("tells an empty list apart from a failed one", async () => {
		list.mockResolvedValue(page([]));

		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(wrapper.find(".empty").exists()).toBe(true);
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
	});

	it("shows a loading state, not the empty state, while the first page is on its way", async () => {
		const first = gate<ReturnType<typeof page>>();
		list.mockReturnValue(first.promise);

		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(wrapper.find('[role="status"]').text()).toBe("Loading posts...");
		expect(wrapper.find(".empty").exists()).toBe(false);

		first.open(page([post()]));
		await flushPromises();

		expect(wrapper.find('[role="status"]').exists()).toBe(false);
		expect(wrapper.findAll("li strong").map((n) => n.text())).toEqual(["Hello"]);
	});

	it("offers no Load more on the last page", async () => {
		const wrapper = mount(PostsPanel);
		await flushPromises();

		expect(list).toHaveBeenCalledWith({});
		expect(moreButton(wrapper)).toBeUndefined();
	});

	it("appends the next page after the last, asking with the server's cursor", async () => {
		list.mockResolvedValueOnce(page([post({ id: "a1", title: "A" })], "cursor-1"));
		list.mockResolvedValueOnce(page([post({ id: "b1", title: "B" })], "cursor-2"));
		list.mockResolvedValueOnce(page([post({ id: "c1", title: "C" })]));

		const wrapper = mount(PostsPanel);
		await flushPromises();

		await moreButton(wrapper)?.trigger("click");
		await flushPromises();

		expect(list).toHaveBeenLastCalledWith({ cursor: "cursor-1" });
		expect(wrapper.findAll("li strong").map((n) => n.text())).toEqual(["A", "B"]);

		await moreButton(wrapper)?.trigger("click");
		await flushPromises();

		expect(list).toHaveBeenLastCalledWith({ cursor: "cursor-2" });
		expect(wrapper.findAll("li strong").map((n) => n.text())).toEqual(["A", "B", "C"]);
		expect(moreButton(wrapper)).toBeUndefined();
	});

	it("disables Load more while a page is loading, so one click asks once", async () => {
		const next = gate<ReturnType<typeof page>>();
		list.mockResolvedValueOnce(page([post({ id: "a1", title: "A" })], "cursor-1"));
		list.mockReturnValueOnce(next.promise);

		const wrapper = mount(PostsPanel);
		await flushPromises();

		await moreButton(wrapper)?.trigger("click");

		expect(moreButton(wrapper)?.text()).toBe("Loading...");
		expect(moreButton(wrapper)?.attributes("disabled")).toBeDefined();

		next.open(page([post({ id: "b1", title: "B" })]));
		await flushPromises();

		expect(list).toHaveBeenCalledTimes(2);
	});

	it("keeps the loaded posts when the next page fails, and retries the same page", async () => {
		list.mockResolvedValueOnce(page([post({ id: "a1", title: "A" })], "cursor-1"));
		list.mockRejectedValueOnce(new Error("The feed is temporarily unavailable"));
		list.mockResolvedValueOnce(page([post({ id: "b1", title: "B" })]));

		const wrapper = mount(PostsPanel);
		await flushPromises();

		await moreButton(wrapper)?.trigger("click");
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe("The feed is temporarily unavailable");
		expect(wrapper.findAll("li strong").map((n) => n.text())).toEqual(["A"]);
		expect(moreButton(wrapper)?.text()).toBe("Load more");

		await moreButton(wrapper)?.trigger("click");
		await flushPromises();

		expect(list).toHaveBeenLastCalledWith({ cursor: "cursor-1" });
		expect(wrapper.findAll("li strong").map((n) => n.text())).toEqual(["A", "B"]);
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
	});

	it("retries a failed first page from the error", async () => {
		list.mockRejectedValueOnce(new Error("Internal server error"));
		list.mockResolvedValueOnce(page([post()]));

		const wrapper = mount(PostsPanel);
		await flushPromises();

		await wrapper.find(".failed button").trigger("click");
		await flushPromises();

		expect(list).toHaveBeenLastCalledWith({});
		expect(wrapper.findAll("li strong").map((n) => n.text())).toEqual(["Hello"]);
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
	});

	it("keeps paging after the last server row when a post was created in between", async () => {
		currentUser.value = user();
		list.mockResolvedValueOnce(page([post({ id: "a1", title: "A" })], "cursor-1"));
		list.mockResolvedValueOnce(page([post({ id: "b1", title: "B" })]));
		create.mockResolvedValue(post({ id: "new", title: "Fresh" }));

		const wrapper = mount(PostsPanel);
		await flushPromises();

		await wrapper.find("input").setValue("Fresh");
		await wrapper.find("textarea").setValue("Body");
		await wrapper.find("form").trigger("submit");
		await flushPromises();

		await moreButton(wrapper)?.trigger("click");
		await flushPromises();

		expect(list).toHaveBeenLastCalledWith({ cursor: "cursor-1" });
		expect(wrapper.findAll("li strong").map((n) => n.text())).toEqual(["Fresh", "A", "B"]);
	});
});
