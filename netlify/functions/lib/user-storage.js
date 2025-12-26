const { getStore } = require('@netlify/blobs');
const crypto = require('node:crypto');

/**
 * User Storage Manager for Authentication
 * Handles CRUD operations for user accounts in Netlify Blobs
 *
 * Storage Structure:
 * - users: Array of user objects
 * - verification-tokens: Map of token -> user data
 * - login-attempts: Map of email -> attempt data (for rate limiting)
 */

const USERS_BLOB_KEY = 'users';
const TOKENS_BLOB_KEY = 'verification-tokens';
const LOGIN_ATTEMPTS_BLOB_KEY = 'login-attempts';

/**
 * Get configured Netlify Blobs store
 * @returns {Object} Netlify Blobs store instance
 */
function getAuthStore() {
    return getStore({
        name: 'auth-data',
        siteID: process.env.SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
    });
}

/**
 * Get all users from storage
 * @returns {Promise<Array>} Array of user objects
 */
async function getUsers() {
    const store = getAuthStore();
    const usersBlob = await store.get(USERS_BLOB_KEY, { type: 'json' });
    return usersBlob || [];
}

/**
 * Save users to storage with retry logic
 * @param {Array} users - Array of user objects
 * @returns {Promise<void>}
 */
async function saveUsers(users) {
    const store = getAuthStore();
    const maxRetries = 5;

    for (let i = 0; i < maxRetries; i++) {
        try {
            await store.setJSON(USERS_BLOB_KEY, users);
            return;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            // Exponential backoff
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100));
        }
    }
}

/**
 * Find user by email
 * @param {string} email - User email
 * @returns {Promise<Object|null>} User object or null
 */
async function findUserByEmail(email) {
    const users = await getUsers();
    const normalizedEmail = normalizeEmail(email);
    return users.find(u => u.email === normalizedEmail) || null;
}

/**
 * Create a new user account
 * @param {Object} userData - User data (email, hashedPassword)
 * @returns {Promise<Object>} Created user object
 */
async function createUser(userData) {
    const users = await getUsers();
    const normalizedEmail = normalizeEmail(userData.email);

    // Check if user already exists
    if (users.some(u => u.email === normalizedEmail)) {
        throw new Error('User already exists');
    }

    const newUser = {
        id: crypto.randomBytes(16).toString('hex'),
        email: normalizedEmail,
        hashedPassword: userData.hashedPassword,
        verified: false,
        createdAt: new Date().toISOString(),
        failedLoginAttempts: 0,
        lockedUntil: null
    };

    users.push(newUser);
    await saveUsers(users);

    return newUser;
}

/**
 * Update user account
 * @param {string} email - User email
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated user object
 */
async function updateUser(email, updates) {
    const users = await getUsers();
    const normalizedEmail = normalizeEmail(email);
    const userIndex = users.findIndex(u => u.email === normalizedEmail);

    if (userIndex === -1) {
        throw new Error('User not found');
    }

    users[userIndex] = { ...users[userIndex], ...updates };
    await saveUsers(users);

    return users[userIndex];
}

/**
 * Delete user account
 * @param {string} email - User email
 * @returns {Promise<boolean>} Success status
 */
async function deleteUser(email) {
    const users = await getUsers();
    const normalizedEmail = normalizeEmail(email);
    const filteredUsers = users.filter(u => u.email !== normalizedEmail);

    if (filteredUsers.length === users.length) {
        return false; // User not found
    }

    await saveUsers(filteredUsers);
    return true;
}

/**
 * Store verification token
 * @param {string} token - Verification token
 * @param {Object} data - Token data (email, expiresAt)
 * @returns {Promise<void>}
 */
async function storeVerificationToken(token, data) {
    const store = getAuthStore();
    const tokens = await store.get(TOKENS_BLOB_KEY, { type: 'json' }) || {};

    tokens[token] = {
        ...data,
        createdAt: new Date().toISOString()
    };

    await store.setJSON(TOKENS_BLOB_KEY, tokens);
}

/**
 * Get and validate verification token
 * @param {string} token - Verification token
 * @returns {Promise<Object|null>} Token data or null if invalid/expired
 */
async function getVerificationToken(token) {
    const store = getAuthStore();
    const tokens = await store.get(TOKENS_BLOB_KEY, { type: 'json' }) || {};

    const tokenData = tokens[token];
    if (!tokenData) return null;

    // Check expiration
    if (new Date(tokenData.expiresAt) < new Date()) {
        // Token expired, remove it
        await deleteVerificationToken(token);
        return null;
    }

    return tokenData;
}

/**
 * Delete verification token (after use or expiration)
 * @param {string} token - Verification token
 * @returns {Promise<void>}
 */
async function deleteVerificationToken(token) {
    const store = getAuthStore();
    const tokens = await store.get(TOKENS_BLOB_KEY, { type: 'json' }) || {};

    delete tokens[token];
    await store.setJSON(TOKENS_BLOB_KEY, tokens);
}

/**
 * Record failed login attempt
 * @param {string} email - User email
 * @returns {Promise<number>} Number of failed attempts
 */
async function recordFailedLogin(email) {
    const store = getAuthStore();
    const attempts = await store.get(LOGIN_ATTEMPTS_BLOB_KEY, { type: 'json' }) || {};
    const normalizedEmail = normalizeEmail(email);

    if (!attempts[normalizedEmail]) {
        attempts[normalizedEmail] = {
            count: 0,
            firstAttempt: new Date().toISOString()
        };
    }

    attempts[normalizedEmail].count++;
    attempts[normalizedEmail].lastAttempt = new Date().toISOString();

    await store.setJSON(LOGIN_ATTEMPTS_BLOB_KEY, attempts);

    return attempts[normalizedEmail].count;
}

/**
 * Clear failed login attempts (after successful login)
 * @param {string} email - User email
 * @returns {Promise<void>}
 */
async function clearFailedLogins(email) {
    const store = getAuthStore();
    const attempts = await store.get(LOGIN_ATTEMPTS_BLOB_KEY, { type: 'json' }) || {};
    const normalizedEmail = normalizeEmail(email);

    delete attempts[normalizedEmail];
    await store.setJSON(LOGIN_ATTEMPTS_BLOB_KEY, attempts);
}

/**
 * Get failed login attempt count
 * @param {string} email - User email
 * @returns {Promise<number>} Number of failed attempts
 */
async function getFailedLoginCount(email) {
    const store = getAuthStore();
    const attempts = await store.get(LOGIN_ATTEMPTS_BLOB_KEY, { type: 'json' }) || {};
    const normalizedEmail = normalizeEmail(email);

    return attempts[normalizedEmail]?.count || 0;
}

/**
 * Normalize email address (lowercase, remove + aliases)
 * @param {string} email - Raw email
 * @returns {string} Normalized email
 */
function normalizeEmail(email) {
    const [localPart, domain] = email.toLowerCase().split('@');
    // Remove plus addressing (e.g., user+test@domain.com -> user@domain.com)
    const cleanLocalPart = localPart.split('+')[0];
    return `${cleanLocalPart}@${domain}`;
}

/**
 * Clean up expired tokens (maintenance function)
 * @returns {Promise<number>} Number of tokens removed
 */
async function cleanupExpiredTokens() {
    const store = getAuthStore();
    const tokens = await store.get(TOKENS_BLOB_KEY, { type: 'json' }) || {};

    const now = new Date();
    let removedCount = 0;

    for (const [token, data] of Object.entries(tokens)) {
        if (new Date(data.expiresAt) < now) {
            delete tokens[token];
            removedCount++;
        }
    }

    if (removedCount > 0) {
        await store.setJSON(TOKENS_BLOB_KEY, tokens);
    }

    return removedCount;
}

module.exports = {
    getUsers,
    findUserByEmail,
    createUser,
    updateUser,
    deleteUser,
    storeVerificationToken,
    getVerificationToken,
    deleteVerificationToken,
    recordFailedLogin,
    clearFailedLogins,
    getFailedLoginCount,
    normalizeEmail,
    cleanupExpiredTokens
};
