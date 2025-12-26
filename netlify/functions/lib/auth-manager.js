const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
    findUserByEmail,
    createUser,
    updateUser,
    storeVerificationToken,
    getVerificationToken,
    deleteVerificationToken,
    recordFailedLogin,
    clearFailedLogins,
    getFailedLoginCount
} = require('./user-storage');

/**
 * Authentication Manager
 * Handles password hashing, JWT generation, email verification, and login logic
 */

// Configuration from environment variables
const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-in-production';
const JWT_EXPIRES_IN = '7d'; // 7 days
const BCRYPT_ROUNDS = 12; // Cost factor for bcrypt
const VERIFICATION_TOKEN_EXPIRY = 48 * 60 * 60 * 1000; // 48 hours in ms
const MAX_LOGIN_ATTEMPTS = 5;
const ACCOUNT_LOCK_DURATION = 15 * 60 * 1000; // 15 minutes in ms
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || 'syntegon.com';

/**
 * Validate email domain
 * @param {string} email - Email address
 * @returns {boolean} True if email domain is allowed
 */
function isValidEmailDomain(email) {
    const domain = email.split('@')[1];
    return domain === ALLOWED_EMAIL_DOMAIN;
}

/**
 * Validate email format
 * @param {string} email - Email address
 * @returns {boolean} True if email format is valid
 */
function isValidEmailFormat(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Validate password strength
 * @param {string} password - Password
 * @returns {Object} { valid: boolean, message: string }
 */
function validatePassword(password) {
    if (password.length < 8) {
        return { valid: false, message: 'Password must be at least 8 characters long' };
    }
    if (!/[A-Z]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one uppercase letter' };
    }
    if (!/[a-z]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one lowercase letter' };
    }
    if (!/[0-9]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one number' };
    }
    return { valid: true, message: 'Password is valid' };
}

/**
 * Hash password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Hashed password
 */
async function hashPassword(password) {
    return await bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Verify password against hash
 * @param {string} password - Plain text password
 * @param {string} hashedPassword - Hashed password
 * @returns {Promise<boolean>} True if password matches
 */
async function verifyPassword(password, hashedPassword) {
    return await bcrypt.compare(password, hashedPassword);
}

/**
 * Generate JWT token
 * @param {Object} payload - Token payload (userId, email)
 * @returns {string} JWT token
 */
function generateJWT(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verify and decode JWT token
 * @param {string} token - JWT token
 * @returns {Object|null} Decoded payload or null if invalid
 */
function verifyJWT(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

/**
 * Generate cryptographically secure verification token
 * @returns {string} Verification token
 */
function generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Register new user account
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<Object>} { success: boolean, message: string, verificationToken?: string }
 */
async function registerUser(email, password) {
    // Validate email format
    if (!isValidEmailFormat(email)) {
        return { success: false, message: 'Invalid email format' };
    }

    // Validate email domain
    if (!isValidEmailDomain(email)) {
        return {
            success: false,
            message: `Only @${ALLOWED_EMAIL_DOMAIN} email addresses are allowed`
        };
    }

    // Validate password strength
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
        return { success: false, message: passwordValidation.message };
    }

    // Check if user already exists
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
        return { success: false, message: 'An account with this email already exists' };
    }

    // Hash password
    const hashedPassword = await hashPassword(password);

    // Create user (unverified)
    try {
        const user = await createUser({ email, hashedPassword });

        // Generate verification token
        const verificationToken = generateVerificationToken();
        const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY).toISOString();

        await storeVerificationToken(verificationToken, {
            email: user.email,
            expiresAt
        });

        return {
            success: true,
            message: 'Account created. Please check your email to verify your account.',
            verificationToken, // This will be used to send verification email
            email: user.email
        };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

/**
 * Verify email with token
 * @param {string} token - Verification token
 * @returns {Promise<Object>} { success: boolean, message: string }
 */
async function verifyEmail(token) {
    const tokenData = await getVerificationToken(token);

    if (!tokenData) {
        return { success: false, message: 'Invalid or expired verification token' };
    }

    // Update user to verified
    try {
        await updateUser(tokenData.email, { verified: true });
        await deleteVerificationToken(token);

        return {
            success: true,
            message: 'Email verified successfully. You can now log in.'
        };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

/**
 * Check if account is locked due to failed login attempts
 * @param {Object} user - User object
 * @returns {boolean} True if account is locked
 */
function isAccountLocked(user) {
    if (!user.lockedUntil) return false;

    const lockExpiry = new Date(user.lockedUntil);
    const now = new Date();

    return now < lockExpiry;
}

/**
 * Login user with email and password
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<Object>} { success: boolean, message: string, token?: string, user?: Object }
 */
async function loginUser(email, password) {
    // Find user
    const user = await findUserByEmail(email);

    if (!user) {
        return { success: false, message: 'Invalid email or password' };
    }

    // Check if account is verified
    if (!user.verified) {
        return {
            success: false,
            message: 'Please verify your email address before logging in'
        };
    }

    // Check if account is locked
    if (isAccountLocked(user)) {
        const lockExpiry = new Date(user.lockedUntil);
        const minutesRemaining = Math.ceil((lockExpiry - new Date()) / 60000);
        return {
            success: false,
            message: `Account is temporarily locked. Please try again in ${minutesRemaining} minute(s).`
        };
    }

    // Verify password
    const isPasswordValid = await verifyPassword(password, user.hashedPassword);

    if (!isPasswordValid) {
        // Record failed attempt
        const failedAttempts = await recordFailedLogin(email);

        // Lock account if max attempts reached
        if (failedAttempts >= MAX_LOGIN_ATTEMPTS) {
            const lockedUntil = new Date(Date.now() + ACCOUNT_LOCK_DURATION).toISOString();
            await updateUser(email, {
                lockedUntil,
                failedLoginAttempts: failedAttempts
            });

            return {
                success: false,
                message: `Too many failed login attempts. Account locked for ${ACCOUNT_LOCK_DURATION / 60000} minutes.`
            };
        }

        return {
            success: false,
            message: `Invalid email or password (${failedAttempts}/${MAX_LOGIN_ATTEMPTS} attempts)`
        };
    }

    // Clear failed login attempts
    await clearFailedLogins(email);

    // Clear account lock if it was set
    if (user.lockedUntil) {
        await updateUser(email, { lockedUntil: null, failedLoginAttempts: 0 });
    }

    // Generate JWT
    const token = generateJWT({
        userId: user.id,
        email: user.email
    });

    return {
        success: true,
        message: 'Login successful',
        token,
        user: {
            id: user.id,
            email: user.email
        }
    };
}

/**
 * Validate authentication token and return user
 * @param {string} token - JWT token
 * @returns {Promise<Object>} { valid: boolean, user?: Object, message?: string }
 */
async function validateAuthToken(token) {
    if (!token) {
        return { valid: false, message: 'No authentication token provided' };
    }

    // Verify JWT
    const decoded = verifyJWT(token);
    if (!decoded) {
        return { valid: false, message: 'Invalid or expired token' };
    }

    // Get user from database
    const user = await findUserByEmail(decoded.email);
    if (!user) {
        return { valid: false, message: 'User not found' };
    }

    if (!user.verified) {
        return { valid: false, message: 'User email not verified' };
    }

    return {
        valid: true,
        user: {
            id: user.id,
            email: user.email
        }
    };
}

module.exports = {
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
    validateAuthToken,
    ALLOWED_EMAIL_DOMAIN
};
