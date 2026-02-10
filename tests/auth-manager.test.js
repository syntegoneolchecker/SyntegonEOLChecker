const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

jest.mock("../netlify/functions/lib/user-storage");
const {
	findUserByEmail,
	createUser,
	storeVerificationToken,
	getVerificationToken,
	updateUser,
	deleteVerificationToken,
	recordFailedLogin,
	clearFailedLogins
} = require("../netlify/functions/lib/user-storage");

// Setting environment variables for testing
process.env.ALLOWED_EMAIL_DOMAIN = "syntegon.com";
process.env.JWT_SECRET = "test_secret";

const {
	isValidEmailDomain,
	isValidEmailFormat,
	validatePassword,
	hashPassword,
	verifyPassword,
	generateJWT,
	verifyJWT,
	generateVerificationToken,
	registerUser,
	verifyEmail,
	loginUser,
	validateAuthToken
} = require("../netlify/functions/lib/auth-manager");

beforeEach(() => {
	jest.resetAllMocks();
});

describe("isValidEmailDomain", () => {
	// Tests represent only single @ inputs since isValidEmailFormat guarantees that format (abc@syntegon.com@xyz would return true)
	it("should reject wrong domain", () => {
		expect(isValidEmailDomain("test@gmail.com")).toBe(false);
	});
	it("should accept correct domain", () => {
		expect(isValidEmailDomain("test@syntegon.com")).toBe(true);
	});
	// Function is case sensitive
	it("should reject wrong case", () => {
		expect(isValidEmailDomain("test@SyNtEgOn.CoM")).toBe(false);
	});
	it("should work with the fallback if environment variable is not set", () => {
		jest.resetModules();
		delete process.env.ALLOWED_EMAIL_DOMAIN;

		const { isValidEmailDomain } = require("../netlify/functions/lib/auth-manager");
		expect(isValidEmailDomain("test@syntegon.com")).toBe(true);

		// Restore for other tests
		process.env.ALLOWED_EMAIL_DOMAIN = "syntegon.com";
		process.env.JWT_SECRET = "test_secret";
	});
});

describe("isValidEmailFormat", () => {
	it("should reject empty strings", () => {
		expect(isValidEmailFormat("")).toBe(false);
	});
	it("should reject multiple @ in the email", () => {
		expect(isValidEmailFormat("test@something@syntegon.com")).toBe(false);
	});
	it("should reject spaces in the email", () => {
		expect(isValidEmailFormat("This is @email.com")).toBe(false);
	});
	it("should reject emails with no @", () => {
		expect(isValidEmailFormat("emailsyntegon.com")).toBe(false);
	});
	it("should accept a correct email format", () => {
		expect(isValidEmailFormat("email@domain.com")).toBe(true);
	});
});

describe("validatePassword", () => {
	it("should reject a password shorter than 8 characters", () => {
		expect(validatePassword("Pw12345")).toEqual({
			valid: false,
			message: "Password must be at least 8 characters long"
		});
	});
	it("should reject a password without any uppercase letters", () => {
		expect(validatePassword("password123")).toEqual({
			valid: false,
			message: "Password must contain at least one uppercase letter"
		});
	});
	it("should reject a password without any lowercase letters", () => {
		expect(validatePassword("PASSWORD123")).toEqual({
			valid: false,
			message: "Password must contain at least one lowercase letter"
		});
	});
	it("should reject a password without any numbers", () => {
		expect(validatePassword("PASSWORDsecret")).toEqual({
			valid: false,
			message: "Password must contain at least one number"
		});
	});
	it("should accept a password with at least 8 characters and contain lowercase, uppercase, and number characters", () => {
		expect(validatePassword("PassW123")).toEqual({
			valid: true,
			message: "Password is valid"
		});
	});
});

describe("hashPassword", () => {
	it("should not return the password unchanged", async () => {
		expect(await hashPassword("TestPW123")).not.toBe("TestPW123");
	});
	it("should return a string starting with $2a$ or $2b$", async () => {
		expect(await hashPassword("TestPW123")).toMatch(/^\$2[ab]\$/);
	});
	it("should produce unique hashes for different passwords", async () => {
		const hashOne = await hashPassword("TestPW123");
		const hashTwo = await hashPassword("123TestPW");
		expect(hashOne).not.toMatch(hashTwo);
	});
});

describe("verifyPassword", () => {
	it("should reject a wrong password", async () => {
		const hash = await bcrypt.hash("CorrectPassword", 1);
		expect(await verifyPassword("WrongPassword", hash)).toBe(false);
	});
	it("should accept the correct password", async () => {
		const hash = await bcrypt.hash("CorrectPassword", 1);
		expect(await verifyPassword("CorrectPassword", hash)).toBe(true);
	});
});

describe("generateJWT / verifyJWT", () => {
	it("should generate a token, verify it, and return the original payload and expiration properties", () => {
		const payload = { email: "user.name@syntegon.com", userId: "123" };
		const token = generateJWT(payload);
		const decoded = verifyJWT(token);

		expect(decoded.email).toBe(payload.email);
		expect(decoded.userId).toBe(payload.userId);
		expect(decoded).toHaveProperty("iat");
		expect(decoded).toHaveProperty("exp");
	});
	it("should return null when verifying invalid token", () => {
		expect(verifyJWT("Some_Invalid_Token")).toBeNull();
	});
	it("should reject a token signed with a different secret", () => {
		const jwt = require("jsonwebtoken");
		// prettier-ignore
		const token = jwt.sign( // NOSONAR
            { email: "user.name@syntegon.com", userId: "123" },
            "wrong-secret",
            { expiresIn: "7d" },
        );
		expect(verifyJWT(token)).toBeNull();
	});
});

describe("generateVerificationToken", () => {
	it("should return a 64 character hex string", () => {
		expect(generateVerificationToken()).toMatch(/^[0-9a-fA-F]{64}$/);
	});
	it("should return different output with each call", () => {
		const tokenA = generateVerificationToken();
		const tokenB = generateVerificationToken();
		expect(tokenA).not.toBe(tokenB);
	});
});

describe("registerUser", () => {
	it("should reject invalid email format", async () => {
		expect(await registerUser("abc@domain", "Password999")).toEqual({
			success: false,
			message: "Invalid email format"
		});
	});
	it("should reject invalid domain", async () => {
		expect(await registerUser("abc@badDomain.net", "Password999")).toEqual({
			success: false,
			message: `Only @syntegon.com email addresses are allowed`
		});
	});
	it("should reject weak password", async () => {
		expect(await registerUser("abc@syntegon.com", "PW1weak")).toEqual({
			success: false,
			message: "Password must be at least 8 characters long"
		});
	});
	it("should reject registration with an email that is registered already", async () => {
		// Return object containing the same email as the input email
		findUserByEmail.mockResolvedValue({ email: "user@syntegon.com" });

		expect(await registerUser("user@syntegon.com", "Passw999")).toEqual({
			success: false,
			message: "An account with this email already exists"
		});
	});
	it("should allow creation of new users with correct email, domain, and strong password", async () => {
		// Return null to show that the input email does not have an account yet
		findUserByEmail.mockResolvedValue(null);
		createUser.mockResolvedValue({
			id: crypto.randomBytes(16).toString("hex"),
			email: "user@syntegon.com",
			hashedPassword: await hashPassword("Passw999"),
			verified: false,
			createdAt: new Date().toISOString(),
			failedLoginAttempts: 0,
			lockedUntil: null
		});
		storeVerificationToken.mockResolvedValue();

		const result = await registerUser("user@syntegon.com", "Passw999");

		expect(result.success).toEqual(true);
		expect(result.message).toEqual(
			"Account created. Please check your email to verify your account."
		);
		expect(result.verificationToken).toMatch(/^[a-f0-9]{64}$/);
		expect(result.email).toEqual("user@syntegon.com");
	});
	it("should throw an error if account creation fails", async () => {
		const errorMessage = "Connection lost or some other unexpected error";

		// Return null to show that the input email does not have an account yet
		findUserByEmail.mockResolvedValue(null);
		createUser.mockRejectedValue(new Error(errorMessage));

		expect(await registerUser("user@syntegon.com", "Passw999")).toEqual({
			success: false,
			message: errorMessage
		});
	});
});

describe("verifyEmail", () => {
	it("should reject invalid or expired tokens", async () => {
		getVerificationToken.mockResolvedValue(null);

		expect(await verifyEmail("invalidOrExpiredToken")).toEqual({
			success: false,
			message: "Invalid or expired verification token"
		});
	});
	it("should accept a valid token", async () => {
		getVerificationToken.mockResolvedValue({ token: "tokenThatExists" });
		updateUser.mockResolvedValue({ user: "updatedUser" });
		deleteVerificationToken.mockResolvedValue();

		expect(await verifyEmail("tokenThatExists")).toEqual({
			success: true,
			message: "Email verified successfully. You can now log in."
		});
	});
	it("should thrown an error if updating user fails", async () => {
		const errorMessage = "Connection failed or some other unexpected error";

		getVerificationToken.mockResolvedValue({ token: "tokenThatExists" });
		updateUser.mockRejectedValue(new Error(errorMessage));

		expect(await verifyEmail("tokenThatExists")).toEqual({
			success: false,
			message: errorMessage
		});
	});
});

describe("loginUser", () => {
	it("should reject users that do not exist", async () => {
		findUserByEmail.mockResolvedValue(null);

		expect(await loginUser("doesNotExist@syntegon.com", "Password1")).toEqual({
			success: false,
			message: "Invalid email or password"
		});
	});
	it("should reject unverified users", async () => {
		findUserByEmail.mockResolvedValue({ verified: false });

		expect(await loginUser("unverified@syntegon.com", "Password1")).toEqual({
			success: false,
			message: "Please verify your email address before logging in"
		});
	});
	it("should reject users with locked accounts", async () => {
		const now = Date.now();
		const lockedUntil = new Date(now + 5 * 60 * 1000);

		findUserByEmail.mockResolvedValue({
			verified: true,
			lockedUntil: lockedUntil
		});

		expect(await loginUser("lockedAccount@syntegon.com", "Password1")).toEqual({
			success: false,
			message: `Account is temporarily locked. Please try again in 5 minute(s).`
		});
	});
	it("should accept users with expired account locks and clear old locks", async () => {
		const now = Date.now();
		const lockedUntil = new Date(now - 1);
		const email = "user@syntegon.com";
		const password = "Password1"; // NOSONAR
		const hashedPassword = await bcrypt.hash(password, 1); // Faster bcrypt to improve test speed

		findUserByEmail.mockResolvedValue({
			id: "123",
			email: email,
			verified: true,
			lockedUntil: lockedUntil,
			hashedPassword: hashedPassword
		});
		clearFailedLogins.mockResolvedValue();
		updateUser.mockResolvedValue();

		const result = await loginUser(email, password);
		expect(result.success).toBe(true);

		// Old lock is cleared
		expect(updateUser).toHaveBeenCalledWith("user@syntegon.com", {
			lockedUntil: null,
			failedLoginAttempts: 0
		});
	});
	it("should reject users with wrong passwords and show the number of attempts", async () => {
		const email = "user@syntegon.com";
		const password = "Password1"; // NOSONAR
		const hashedPassword = await bcrypt.hash("Password2", 1);

		findUserByEmail.mockResolvedValue({
			id: "123",
			email: email,
			verified: true,
			lockedUntil: null,
			hashedPassword: hashedPassword
		});
		recordFailedLogin.mockResolvedValue(4);

		expect(await loginUser(email, password)).toEqual({
			success: false,
			message: `Invalid email or password (4/5 attempts)`
		});
	});
	it("should lock the users account if the max attempts have been reached", async () => {
		const email = "user@syntegon.com";
		const password = "Password1"; // NOSONAR
		const hashedPassword = await bcrypt.hash("Password2", 1);

		findUserByEmail.mockResolvedValue({
			id: "123",
			email: email,
			verified: true,
			lockedUntil: null,
			hashedPassword: hashedPassword
		});
		recordFailedLogin.mockResolvedValue(5);
		updateUser.mockResolvedValue();

		expect(await loginUser(email, password)).toEqual({
			success: false,
			message: `Too many failed login attempts. Account locked for 15 minutes.`
		});
	});
	it("should allow login with correct credentials and valid account", async () => {
		const email = "username@syntegon.com";
		const password = "Password1"; // NOSONAR
		const hashedPassword = await bcrypt.hash(password, 1);

		findUserByEmail.mockResolvedValue({
			id: "123",
			email: email,
			verified: true,
			lockedUntil: null,
			hashedPassword: hashedPassword
		});
		clearFailedLogins.mockResolvedValue();
		updateUser.mockResolvedValue();

		const result = await loginUser(email, password);
		expect(result.success).toBe(true);
	});
});

describe("validateAuthToken", () => {
	it("should reject a non-existent token", async () => {
		expect(await validateAuthToken(null)).toEqual({
			valid: false,
			message: "No authentication token provided"
		});
	});
	it("should reject an invalid token", async () => {
		expect(await validateAuthToken("AnInvalidToken")).toEqual({
			valid: false,
			message: "Invalid or expired token"
		});
	});
	it("should reject a valid token of an user that does not exist", async () => {
		const payload = { email: "user.name@syntegon.com", userId: "123" };
		const token = generateJWT(payload);

		findUserByEmail.mockResolvedValue(null);

		expect(await validateAuthToken(token)).toEqual({
			valid: false,
			message: "User not found"
		});
	});
	it("should reject a valid token of an unverified user", async () => {
		const payload = { email: "user.name@syntegon.com", userId: "123" };
		const token = generateJWT(payload);

		findUserByEmail.mockResolvedValue({
			verified: false
		});

		expect(await validateAuthToken(token)).toEqual({
			valid: false,
			message: "User email not verified"
		});
	});
	it("should accept a valid token of a verified user", async () => {
		const email = "user@syntegon.com";
		const id = "123";
		const payload = { email: "user.name@syntegon.com", userId: "123" };
		const token = generateJWT(payload);

		findUserByEmail.mockResolvedValue({
			id: id,
			email: email,
			verified: true
		});

		expect(await validateAuthToken(token)).toEqual({
			valid: true,
			user: {
				id: id,
				email: email
			}
		});
	});
});

describe("JWT_SECRET requirement", () => {
	it("should throw if JWT_SECRET is not set", () => {
		jest.resetModules();
		delete process.env.JWT_SECRET;

		expect(() => {
			require("../netlify/functions/lib/auth-manager");
		}).toThrow("JWT_SECRET environment variable is required but not set");

		// Restore for other tests
		process.env.ALLOWED_EMAIL_DOMAIN = "syntegon.com";
		process.env.JWT_SECRET = "test_secret";
	});
});
