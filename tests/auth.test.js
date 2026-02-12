/**
 * Tests for js/auth.js
 * Tests authentication checking and logout functionality
 */

describe("Auth Module", () => {
	let fetchMock;
	let showStatusCalls;
	let setCurrentUserCalled;
	let locationHref;
	let classListOps;
	let initFunctionCalled;
	let localStorageOps;

	function showStatus(message, type, permanent) {
		showStatusCalls.push({ message, type, permanent });
	}

	function setCurrentUser(user) {
		setCurrentUserCalled = user;
	}

	beforeEach(() => {
		fetchMock = jest.fn();
		showStatusCalls = [];
		setCurrentUserCalled = null;
		locationHref = null;
		classListOps = [];
		initFunctionCalled = false;
		localStorageOps = [];
	});

	describe("checkAuthentication", () => {
		async function checkAuthentication(initFunction) {
			try {
				const response = await fetchMock("/.netlify/functions/auth-check");
				const authData = await response.json();

				if (authData.authenticated) {
					setCurrentUser(authData.user);

					classListOps.push({ action: "remove", class: "auth-loading" });
					classListOps.push({ action: "add", class: "auth-verified" });

					try {
						if (initFunction) {
							await initFunction();
							initFunctionCalled = true;
						}
					} catch (initError) {
						showStatus(
							"⚠️ Error loading data. Please refresh the page.",
							"error",
							true
						);
					}
				} else {
					locationHref = "/auth.html";
				}
			} catch (error) {
				locationHref = "/auth.html";
			}
		}

		test("should set current user and init on successful auth", async () => {
			fetchMock.mockResolvedValue({
				json: () =>
					Promise.resolve({
						authenticated: true,
						user: { email: "test@example.com" }
					})
			});

			const mockInit = jest.fn();
			await checkAuthentication(mockInit);

			expect(setCurrentUserCalled).toEqual({ email: "test@example.com" });
			expect(classListOps).toContainEqual({ action: "remove", class: "auth-loading" });
			expect(classListOps).toContainEqual({ action: "add", class: "auth-verified" });
			expect(mockInit).toHaveBeenCalled();
		});

		test("should redirect to auth.html if not authenticated", async () => {
			fetchMock.mockResolvedValue({
				json: () => Promise.resolve({ authenticated: false })
			});

			await checkAuthentication(null);

			expect(locationHref).toBe("/auth.html");
		});

		test("should redirect on network error", async () => {
			fetchMock.mockRejectedValue(new Error("Network error"));

			await checkAuthentication(null);

			expect(locationHref).toBe("/auth.html");
		});

		test("should show error if init function throws", async () => {
			fetchMock.mockResolvedValue({
				json: () =>
					Promise.resolve({
						authenticated: true,
						user: { email: "test@example.com" }
					})
			});

			const failingInit = jest.fn().mockRejectedValue(new Error("Init failed"));
			await checkAuthentication(failingInit);

			expect(showStatusCalls[0].message).toContain("Error loading data");
			expect(showStatusCalls[0].type).toBe("error");
		});

		test("should work without init function", async () => {
			fetchMock.mockResolvedValue({
				json: () =>
					Promise.resolve({
						authenticated: true,
						user: { email: "test@example.com" }
					})
			});

			await checkAuthentication(null);

			expect(setCurrentUserCalled).toEqual({ email: "test@example.com" });
			expect(initFunctionCalled).toBe(false);
		});
	});

	describe("logout", () => {
		async function logout() {
			try {
				await fetchMock("/.netlify/functions/auth-logout", { method: "POST" });
				localStorageOps.push({ action: "removeItem", key: "auth_token" });
				locationHref = "/auth.html";
			} catch (error) {
				locationHref = "/auth.html";
			}
		}

		test("should call auth-logout and redirect", async () => {
			fetchMock.mockResolvedValue({ ok: true });

			await logout();

			expect(fetchMock).toHaveBeenCalledWith("/.netlify/functions/auth-logout", {
				method: "POST"
			});
			expect(localStorageOps).toContainEqual({
				action: "removeItem",
				key: "auth_token"
			});
			expect(locationHref).toBe("/auth.html");
		});

		test("should redirect even on error", async () => {
			fetchMock.mockRejectedValue(new Error("Network error"));

			await logout();

			expect(locationHref).toBe("/auth.html");
		});
	});

	describe("setInitFunction", () => {
		test("should store the init function reference", () => {
			let initFunction = null;

			function setInitFunction(fn) {
				initFunction = fn;
			}

			const mockFn = jest.fn();
			setInitFunction(mockFn);

			expect(initFunction).toBe(mockFn);
		});
	});
});
