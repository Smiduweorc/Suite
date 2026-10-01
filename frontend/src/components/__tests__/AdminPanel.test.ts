import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../../composables/useAuth";
import AdminPanel from "../AdminPanel.vue";

const list = vi.fn();
const setRole = vi.fn();
const remove = vi.fn();

const AT = "2026-01-01T00:00:00.000000Z";
const ROOT = "11111111-1111-4111-8111-111111111111";

const currentUser = {
	value: {
		id: ROOT,
		email: "root@example.com",
		name: "Root",
		role: "admin",
		createdAt: AT,
		updatedAt: AT,
	} as CurrentUser,
};

vi.mock("../../composables/useAuth", () => ({
	useAuth: () => ({ user: currentUser }),
}));

vi.mock("../../lib/trpc", () => ({
	trpc: {
		user: {
			list: { query: (...args: unknown[]) => list(...args) },
			setRole: { mutate: (...args: unknown[]) => setRole(...args) },
			delete: { mutate: (...args: unknown[]) => remove(...args) },
		},
	},
}));

function managed(id: string, name: string, role: "user" | "admin" = "user") {
	return {
		id,
		email: `${name.toLowerCase()}@example.com`,
		emailKey: `${name.toLowerCase()}@example.com`,
		name,
		role,
		createdAt: AT,
		updatedAt: AT,
	};
}

function page(items: ReturnType<typeof managed>[], nextCursor: string | null = null) {
	return { items, nextCursor };
}

const names = (wrapper: ReturnType<typeof mount>) =>
	wrapper.findAll("li strong").map((node) => node.text());

const moreButton = (wrapper: ReturnType<typeof mount>) =>
	wrapper.findAll("button").find((button) => /Load more|Loading\.\.\./.test(button.text()));

describe("AdminPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		list.mockResolvedValue(page([managed(ROOT, "Root", "admin")]));
	});

	it("shows a loading state while the first page is on its way", async () => {
		let open!: (value: ReturnType<typeof page>) => void;
		list.mockReturnValue(new Promise((resolve) => (open = resolve)));

		const wrapper = mount(AdminPanel);
		await flushPromises();

		expect(wrapper.find('[role="status"]').text()).toBe("Loading users...");
		expect(wrapper.text()).not.toContain("No users.");

		open(page([managed(ROOT, "Root", "admin")]));
		await flushPromises();

		expect(wrapper.find('[role="status"]').exists()).toBe(false);
		expect(names(wrapper)).toEqual(["Root"]);
	});

	it("says so when there are no users, and offers no Load more", async () => {
		list.mockResolvedValue(page([]));

		const wrapper = mount(AdminPanel);
		await flushPromises();

		expect(wrapper.text()).toContain("No users.");
		expect(moreButton(wrapper)).toBeUndefined();
	});

	it("shows a failed first page as an error with a retry, not as no users", async () => {
		list.mockRejectedValueOnce(new Error("Admins only"));
		list.mockResolvedValueOnce(page([managed(ROOT, "Root", "admin")]));

		const wrapper = mount(AdminPanel);
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe("Admins only");
		expect(wrapper.text()).not.toContain("No users.");

		await wrapper.find(".failed button").trigger("click");
		await flushPromises();

		expect(names(wrapper)).toEqual(["Root"]);
	});

	it("appends each next page with the server's cursor until there is none", async () => {
		const bob = "22222222-2222-4222-8222-222222222222";
		const cat = "33333333-3333-4333-8333-333333333333";
		list.mockResolvedValueOnce(page([managed(ROOT, "Root", "admin")], "cursor-1"));
		list.mockResolvedValueOnce(page([managed(bob, "Bob")], "cursor-2"));
		list.mockResolvedValueOnce(page([managed(cat, "Cat")]));

		const wrapper = mount(AdminPanel);
		await flushPromises();

		expect(list).toHaveBeenCalledWith({});

		await moreButton(wrapper)?.trigger("click");
		await flushPromises();
		expect(list).toHaveBeenLastCalledWith({ cursor: "cursor-1" });

		await moreButton(wrapper)?.trigger("click");
		await flushPromises();
		expect(list).toHaveBeenLastCalledWith({ cursor: "cursor-2" });

		expect(names(wrapper)).toEqual(["Root", "Bob", "Cat"]);
		expect(moreButton(wrapper)).toBeUndefined();
	});

	it("keeps the loaded users when a page fails, and retries the same page", async () => {
		const bob = "22222222-2222-4222-8222-222222222222";
		list.mockResolvedValueOnce(page([managed(ROOT, "Root", "admin")], "cursor-1"));
		list.mockRejectedValueOnce(new Error("Internal server error"));
		list.mockResolvedValueOnce(page([managed(bob, "Bob")]));

		const wrapper = mount(AdminPanel);
		await flushPromises();

		await moreButton(wrapper)?.trigger("click");
		await flushPromises();

		expect(wrapper.find('[role="alert"]').text()).toBe("Internal server error");
		expect(names(wrapper)).toEqual(["Root"]);
		expect(moreButton(wrapper)?.attributes("disabled")).toBeUndefined();

		await moreButton(wrapper)?.trigger("click");
		await flushPromises();

		expect(list).toHaveBeenLastCalledWith({ cursor: "cursor-1" });
		expect(names(wrapper)).toEqual(["Root", "Bob"]);
	});

	it("disables Load more while a page is loading", async () => {
		list.mockResolvedValueOnce(page([managed(ROOT, "Root", "admin")], "cursor-1"));
		list.mockReturnValueOnce(new Promise(() => {}));

		const wrapper = mount(AdminPanel);
		await flushPromises();

		await moreButton(wrapper)?.trigger("click");

		expect(moreButton(wrapper)?.text()).toBe("Loading...");
		expect(moreButton(wrapper)?.attributes("disabled")).toBeDefined();
	});
});
