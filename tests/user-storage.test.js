// Mock @netlify/blobs
const mockStore = {
    get: jest.fn(),
    setJSON: jest.fn()
};
jest.mock('@netlify/blobs', () => ({
    getStore: jest.fn(() => mockStore)
}));

const {
    getUsers,
    findUserByEmail,
    createUser,
    updateUser,
    deleteUser,
    storeVerificationToken,
    getVerificationToken,
    deleteVerificationToken,
    storePasswordResetToken,
    getPasswordResetToken,
    deletePasswordResetToken,
    recordFailedLogin,
    clearFailedLogins,
    getFailedLoginCount,
    normalizeEmail,
    cleanupExpiredTokens
} = require('../netlify/functions/lib/user-storage');

describe('User Storage', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        process.env.SITE_ID = 'test-site';
        process.env.NETLIFY_BLOBS_TOKEN = 'test-token';
        jest.clearAllMocks();
        mockStore.get.mockResolvedValue(null);
        mockStore.setJSON.mockResolvedValue(undefined);
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('normalizeEmail', () => {
        it('should lowercase email', () => {
            expect(normalizeEmail('User@Syntegon.COM')).toBe('user@syntegon.com');
        });

        it('should remove plus addressing', () => {
            expect(normalizeEmail('user+test@syntegon.com')).toBe('user@syntegon.com');
        });

        it('should handle email with multiple plus signs', () => {
            expect(normalizeEmail('user+test+extra@syntegon.com')).toBe('user@syntegon.com');
        });

        it('should throw for email without @', () => {
            expect(() => normalizeEmail('noatsign')).toThrow('Invalid email format');
        });

        it('should throw for email with multiple @', () => {
            expect(() => normalizeEmail('a@b@c.com')).toThrow('Invalid email format');
        });

        it('should handle normal email unchanged (already lowercase)', () => {
            expect(normalizeEmail('user@syntegon.com')).toBe('user@syntegon.com');
        });
    });

    describe('getUsers', () => {
        it('should return empty array when no users exist', async () => {
            mockStore.get.mockResolvedValue(null);
            const users = await getUsers();
            expect(users).toEqual([]);
        });

        it('should return stored users', async () => {
            const existingUsers = [
                { id: '1', email: 'user1@syntegon.com' },
                { id: '2', email: 'user2@syntegon.com' }
            ];
            mockStore.get.mockResolvedValue(existingUsers);
            const users = await getUsers();
            expect(users).toEqual(existingUsers);
        });
    });

    describe('findUserByEmail', () => {
        it('should find existing user', async () => {
            const users = [
                { id: '1', email: 'user@syntegon.com' },
                { id: '2', email: 'other@syntegon.com' }
            ];
            mockStore.get.mockResolvedValue(users);

            const user = await findUserByEmail('user@syntegon.com');
            expect(user).toEqual({ id: '1', email: 'user@syntegon.com' });
        });

        it('should return null for non-existent user', async () => {
            mockStore.get.mockResolvedValue([]);
            const user = await findUserByEmail('nobody@syntegon.com');
            expect(user).toBeNull();
        });

        it('should normalize email for lookup', async () => {
            const users = [{ id: '1', email: 'user@syntegon.com' }];
            mockStore.get.mockResolvedValue(users);

            const user = await findUserByEmail('User@Syntegon.COM');
            expect(user).toEqual({ id: '1', email: 'user@syntegon.com' });
        });

        it('should strip plus addressing during lookup', async () => {
            const users = [{ id: '1', email: 'user@syntegon.com' }];
            mockStore.get.mockResolvedValue(users);

            const user = await findUserByEmail('user+alias@syntegon.com');
            expect(user).toEqual({ id: '1', email: 'user@syntegon.com' });
        });
    });

    describe('createUser', () => {
        it('should create user with correct fields', async () => {
            mockStore.get.mockResolvedValue([]);

            const user = await createUser({
                email: 'new@syntegon.com',
                hashedPassword: '$2a$12$hash'
            });

            expect(user.email).toBe('new@syntegon.com');
            expect(user.hashedPassword).toBe('$2a$12$hash');
            expect(user.verified).toBe(false);
            expect(user.id).toBeDefined();
            expect(user.id.length).toBe(32); // 16 bytes hex
            expect(user.createdAt).toBeDefined();
            expect(user.failedLoginAttempts).toBe(0);
            expect(user.lockedUntil).toBeNull();

            expect(mockStore.setJSON).toHaveBeenCalled();
        });

        it('should throw if user already exists', async () => {
            mockStore.get.mockResolvedValue([
                { id: '1', email: 'existing@syntegon.com' }
            ]);

            await expect(createUser({
                email: 'existing@syntegon.com',
                hashedPassword: '$2a$12$hash'
            })).rejects.toThrow('User already exists');
        });

        it('should normalize email during creation', async () => {
            mockStore.get.mockResolvedValue([]);

            const user = await createUser({
                email: 'New+Alias@Syntegon.COM',
                hashedPassword: '$2a$12$hash'
            });

            expect(user.email).toBe('new@syntegon.com');
        });
    });

    describe('updateUser', () => {
        it('should update specified fields', async () => {
            mockStore.get.mockResolvedValue([
                { id: '1', email: 'user@syntegon.com', verified: false }
            ]);

            const updated = await updateUser('user@syntegon.com', { verified: true });
            expect(updated.verified).toBe(true);
            expect(updated.email).toBe('user@syntegon.com');
            expect(mockStore.setJSON).toHaveBeenCalled();
        });

        it('should throw if user not found', async () => {
            mockStore.get.mockResolvedValue([]);

            await expect(updateUser('nobody@syntegon.com', { verified: true }))
                .rejects.toThrow('User not found');
        });
    });

    describe('deleteUser', () => {
        it('should remove user from storage', async () => {
            mockStore.get.mockResolvedValue([
                { id: '1', email: 'user@syntegon.com' },
                { id: '2', email: 'other@syntegon.com' }
            ]);

            const result = await deleteUser('user@syntegon.com');
            expect(result).toBe(true);

            const savedUsers = mockStore.setJSON.mock.calls[0][1];
            expect(savedUsers.length).toBe(1);
            expect(savedUsers[0].email).toBe('other@syntegon.com');
        });

        it('should return false if user not found', async () => {
            mockStore.get.mockResolvedValue([]);
            const result = await deleteUser('nobody@syntegon.com');
            expect(result).toBe(false);
        });
    });

    describe('Verification tokens', () => {
        it('should store a verification token', async () => {
            mockStore.get.mockResolvedValue({});

            await storeVerificationToken('abc123', {
                email: 'user@syntegon.com',
                expiresAt: new Date(Date.now() + 3600000).toISOString()
            });

            expect(mockStore.setJSON).toHaveBeenCalledWith(
                'verification-tokens',
                expect.objectContaining({
                    'abc123': expect.objectContaining({
                        email: 'user@syntegon.com'
                    })
                })
            );
        });

        it('should retrieve valid verification token', async () => {
            const futureDate = new Date(Date.now() + 3600000).toISOString();
            mockStore.get.mockResolvedValue({
                'abc123': {
                    email: 'user@syntegon.com',
                    expiresAt: futureDate
                }
            });

            const token = await getVerificationToken('abc123');
            expect(token).not.toBeNull();
            expect(token.email).toBe('user@syntegon.com');
        });

        it('should return null for expired verification token', async () => {
            const pastDate = new Date(Date.now() - 3600000).toISOString();
            mockStore.get.mockResolvedValue({
                'abc123': {
                    email: 'user@syntegon.com',
                    expiresAt: pastDate
                }
            });

            const token = await getVerificationToken('abc123');
            expect(token).toBeNull();
        });

        it('should return null for non-existent token', async () => {
            mockStore.get.mockResolvedValue({});
            const token = await getVerificationToken('nonexistent');
            expect(token).toBeNull();
        });

        it('should delete verification token', async () => {
            mockStore.get.mockResolvedValue({
                'abc123': { email: 'user@syntegon.com' },
                'def456': { email: 'other@syntegon.com' }
            });

            await deleteVerificationToken('abc123');

            const savedTokens = mockStore.setJSON.mock.calls[0][1];
            expect(savedTokens['abc123']).toBeUndefined();
            expect(savedTokens['def456']).toBeDefined();
        });
    });

    describe('Password reset tokens', () => {
        it('should store a password reset token', async () => {
            mockStore.get.mockResolvedValue({});

            await storePasswordResetToken('reset123', {
                email: 'user@syntegon.com',
                expiresAt: new Date(Date.now() + 3600000).toISOString()
            });

            expect(mockStore.setJSON).toHaveBeenCalledWith(
                'password-reset-tokens',
                expect.objectContaining({
                    'reset123': expect.objectContaining({
                        email: 'user@syntegon.com'
                    })
                })
            );
        });

        it('should retrieve valid password reset token', async () => {
            const futureDate = new Date(Date.now() + 3600000).toISOString();
            mockStore.get.mockResolvedValue({
                'reset123': {
                    email: 'user@syntegon.com',
                    expiresAt: futureDate
                }
            });

            const token = await getPasswordResetToken('reset123');
            expect(token).not.toBeNull();
            expect(token.email).toBe('user@syntegon.com');
        });

        it('should return null for expired password reset token', async () => {
            const pastDate = new Date(Date.now() - 3600000).toISOString();
            mockStore.get.mockResolvedValue({
                'reset123': {
                    email: 'user@syntegon.com',
                    expiresAt: pastDate
                }
            });

            const token = await getPasswordResetToken('reset123');
            expect(token).toBeNull();
        });

        it('should delete password reset token', async () => {
            mockStore.get.mockResolvedValue({
                'reset123': { email: 'user@syntegon.com' }
            });

            await deletePasswordResetToken('reset123');

            const savedTokens = mockStore.setJSON.mock.calls[0][1];
            expect(savedTokens['reset123']).toBeUndefined();
        });
    });

    describe('Login attempt tracking', () => {
        it('should record first failed login', async () => {
            mockStore.get.mockResolvedValue({});

            const count = await recordFailedLogin('user@syntegon.com');
            expect(count).toBe(1);

            const savedData = mockStore.setJSON.mock.calls[0][1];
            expect(savedData['user@syntegon.com'].count).toBe(1);
        });

        it('should increment failed login count', async () => {
            mockStore.get.mockResolvedValue({
                'user@syntegon.com': {
                    count: 2,
                    firstAttempt: new Date().toISOString()
                }
            });

            const count = await recordFailedLogin('user@syntegon.com');
            expect(count).toBe(3);
        });

        it('should clear failed logins', async () => {
            mockStore.get.mockResolvedValue({
                'user@syntegon.com': { count: 5 },
                'other@syntegon.com': { count: 2 }
            });

            await clearFailedLogins('user@syntegon.com');

            const savedData = mockStore.setJSON.mock.calls[0][1];
            expect(savedData['user@syntegon.com']).toBeUndefined();
            expect(savedData['other@syntegon.com']).toBeDefined();
        });

        it('should get failed login count', async () => {
            mockStore.get.mockResolvedValue({
                'user@syntegon.com': { count: 3 }
            });

            const count = await getFailedLoginCount('user@syntegon.com');
            expect(count).toBe(3);
        });

        it('should return 0 for user with no failed logins', async () => {
            mockStore.get.mockResolvedValue({});
            const count = await getFailedLoginCount('user@syntegon.com');
            expect(count).toBe(0);
        });
    });

    describe('cleanupExpiredTokens', () => {
        it('should remove expired tokens', async () => {
            const pastDate = new Date(Date.now() - 3600000).toISOString();
            const futureDate = new Date(Date.now() + 3600000).toISOString();

            mockStore.get.mockResolvedValue({
                'expired-token': { email: 'a@syntegon.com', expiresAt: pastDate },
                'valid-token': { email: 'b@syntegon.com', expiresAt: futureDate }
            });

            const removedCount = await cleanupExpiredTokens();
            expect(removedCount).toBe(1);

            const savedTokens = mockStore.setJSON.mock.calls[0][1];
            expect(savedTokens['expired-token']).toBeUndefined();
            expect(savedTokens['valid-token']).toBeDefined();
        });

        it('should return 0 when no tokens expired', async () => {
            const futureDate = new Date(Date.now() + 3600000).toISOString();
            mockStore.get.mockResolvedValue({
                'token1': { expiresAt: futureDate },
                'token2': { expiresAt: futureDate }
            });

            const removedCount = await cleanupExpiredTokens();
            expect(removedCount).toBe(0);
            expect(mockStore.setJSON).not.toHaveBeenCalled();
        });

        it('should handle empty token store', async () => {
            mockStore.get.mockResolvedValue(null);
            const removedCount = await cleanupExpiredTokens();
            expect(removedCount).toBe(0);
        });
    });
});
