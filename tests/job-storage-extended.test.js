/**
 * Extended tests for job-storage.js
 * Covers: saveJobUrls, getJob, updateJobStatus, markUrlFetching,
 *         saveUrlResult, saveFinalResult, replaceJobUrls, addUrlToJob,
 *         deleteJob, cleanupOldJobs, shouldDeleteJob logic
 * All @netlify/blobs calls mocked — no real blob storage
 */

const mockStore = {
    setJSON: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ blobs: [] })
};

jest.mock('@netlify/blobs', () => ({
    getStore: jest.fn(() => mockStore)
}));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

const jobStorage = require('../netlify/functions/lib/job-storage');

describe('Job Storage - Extended', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        mockStore.get.mockResolvedValue(null);
        mockStore.list.mockResolvedValue({ blobs: [] });
    });

    describe('getJob', () => {
        test('should retrieve job from store', async () => {
            const mockJob = { jobId: 'job-123', status: 'created' };
            mockStore.get.mockResolvedValue(mockJob);

            const result = await jobStorage.getJob('job-123');

            expect(result).toEqual(mockJob);
            expect(mockStore.get).toHaveBeenCalledWith('job-123', { type: 'json' });
        });

        test('should return null for non-existent job', async () => {
            mockStore.get.mockResolvedValue(null);

            const result = await jobStorage.getJob('job-nonexistent');

            expect(result).toBeNull();
        });
    });

    describe('deleteJob', () => {
        test('should delete job from store', async () => {
            await jobStorage.deleteJob('job-123');

            expect(mockStore.delete).toHaveBeenCalledWith('job-123');
        });
    });

    describe('saveJobUrls', () => {
        test('should save URLs to existing job', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                status: 'created',
                urls: [],
                urlResults: {}
            });

            const urls = [
                { url: 'https://example.com/page1', index: 0 },
                { url: 'https://example.com/page2', index: 1 }
            ];

            await jobStorage.saveJobUrls('job-123', urls);

            expect(mockStore.setJSON).toHaveBeenCalledWith(
                'job-123',
                expect.objectContaining({
                    status: 'urls_ready',
                    urls: expect.arrayContaining([
                        expect.objectContaining({ url: 'https://example.com/page1', status: 'pending' }),
                        expect.objectContaining({ url: 'https://example.com/page2', status: 'pending' })
                    ]),
                    urlResults: {}
                })
            );
        });

        test('should throw when job not found', async () => {
            mockStore.get.mockResolvedValue(null);

            await expect(jobStorage.saveJobUrls('job-missing', []))
                .rejects.toThrow('Job job-missing not found');
        });
    });

    describe('updateJobStatus', () => {
        test('should update job status', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                status: 'created'
            });

            await jobStorage.updateJobStatus('job-123', 'analyzing');

            expect(mockStore.setJSON).toHaveBeenCalledWith(
                'job-123',
                expect.objectContaining({ status: 'analyzing' })
            );
        });

        test('should set error message when provided', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                status: 'analyzing'
            });

            await jobStorage.updateJobStatus('job-123', 'error', 'LLM rate limited');

            expect(mockStore.setJSON).toHaveBeenCalledWith(
                'job-123',
                expect.objectContaining({
                    status: 'error',
                    error: 'LLM rate limited',
                    completedAt: expect.any(String)
                })
            );
        });

        test('should set completedAt for complete status', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                status: 'analyzing'
            });

            await jobStorage.updateJobStatus('job-123', 'complete');

            const savedJob = mockStore.setJSON.mock.calls[0][1];
            expect(savedJob.completedAt).toBeDefined();
            expect(new Date(savedJob.completedAt).getTime()).toBeLessThanOrEqual(Date.now());
        });

        test('should not overwrite existing completedAt', async () => {
            const existingTimestamp = '2024-01-01T00:00:00.000Z';
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                status: 'analyzing',
                completedAt: existingTimestamp
            });

            await jobStorage.updateJobStatus('job-123', 'complete');

            const savedJob = mockStore.setJSON.mock.calls[0][1];
            expect(savedJob.completedAt).toBe(existingTimestamp);
        });

        test('should merge metadata into job', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                status: 'analyzing'
            });

            await jobStorage.updateJobStatus('job-123', 'error', 'Rate limited', null, {
                retrySeconds: 30,
                groqModel: 'llama-3.3-70b'
            });

            const savedJob = mockStore.setJSON.mock.calls[0][1];
            expect(savedJob.retrySeconds).toBe(30);
            expect(savedJob.groqModel).toBe('llama-3.3-70b');
        });

        test('should throw when job not found', async () => {
            mockStore.get.mockResolvedValue(null);

            await expect(jobStorage.updateJobStatus('job-missing', 'complete'))
                .rejects.toThrow('Job job-missing not found');
        });
    });

    describe('markUrlFetching', () => {
        test('should mark URL as fetching', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                urls: [
                    { index: 0, status: 'pending', url: 'https://example.com/a' },
                    { index: 1, status: 'pending', url: 'https://example.com/b' }
                ]
            });

            await jobStorage.markUrlFetching('job-123', 0);

            const savedJob = mockStore.setJSON.mock.calls[0][1];
            expect(savedJob.urls[0].status).toBe('fetching');
            expect(savedJob.urls[1].status).toBe('pending'); // unchanged
        });

        test('should throw when job not found', async () => {
            mockStore.get.mockResolvedValue(null);

            await expect(jobStorage.markUrlFetching('job-missing', 0))
                .rejects.toThrow('Job job-missing not found');
        });

        test('should not crash when URL index not found', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                urls: [{ index: 0, status: 'pending' }]
            });

            // urlIndex 5 doesn't exist — should not throw
            await jobStorage.markUrlFetching('job-123', 5);

            // setJSON should NOT be called since url was not found
            expect(mockStore.setJSON).not.toHaveBeenCalled();
        });
    });

    describe('saveUrlResult', () => {
        test('should save result and mark URL as complete', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                urls: [
                    { index: 0, status: 'fetching', url: 'https://example.com' },
                    { index: 1, status: 'pending', url: 'https://other.com' }
                ],
                urlResults: {}
            });

            const result = await jobStorage.saveUrlResult('job-123', 0, {
                content: 'Scraped content',
                title: 'Page Title'
            });

            const savedJob = mockStore.setJSON.mock.calls[0][1];
            expect(savedJob.urlResults[0]).toEqual({
                content: 'Scraped content',
                title: 'Page Title'
            });
            expect(savedJob.urls[0].status).toBe('complete');
            expect(result).toBe(false); // Not all complete (URL 1 still pending)
        });

        test('should return true when all URLs are complete', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                urls: [
                    { index: 0, status: 'complete', url: 'https://a.com' },
                    { index: 1, status: 'fetching', url: 'https://b.com' }
                ],
                urlResults: { 0: { content: 'A' } }
            });

            const result = await jobStorage.saveUrlResult('job-123', 1, { content: 'B' });

            expect(result).toBe(true); // All complete now
        });

        test('should throw when job not found', async () => {
            mockStore.get.mockResolvedValue(null);

            await expect(jobStorage.saveUrlResult('job-missing', 0, {}))
                .rejects.toThrow('Job job-missing not found');
        });
    });

    describe('saveFinalResult', () => {
        test('should save final result and mark complete', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                status: 'analyzing',
                finalResult: null
            });

            const finalResult = {
                status: 'DISCONTINUED',
                explanation: 'Product has been discontinued',
                successor: 'MODEL-NEW'
            };

            await jobStorage.saveFinalResult('job-123', finalResult);

            const savedJob = mockStore.setJSON.mock.calls[0][1];
            expect(savedJob.finalResult).toEqual(finalResult);
            expect(savedJob.status).toBe('complete');
            expect(savedJob.completedAt).toBeDefined();
        });

        test('should throw when job not found', async () => {
            mockStore.get.mockResolvedValue(null);

            await expect(jobStorage.saveFinalResult('job-missing', {}))
                .rejects.toThrow('Job job-missing not found');
        });
    });

    describe('replaceJobUrls', () => {
        test('should replace all URLs in job', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                urls: [{ index: 0, url: 'https://old.com', status: 'pending' }],
                urlResults: { 0: { content: 'old' } }
            });

            const newUrls = [
                { url: 'https://new1.com' },
                { url: 'https://new2.com' }
            ];

            await jobStorage.replaceJobUrls('job-123', newUrls);

            const savedJob = mockStore.setJSON.mock.calls[0][1];
            expect(savedJob.urls).toHaveLength(2);
            expect(savedJob.urls[0]).toEqual(expect.objectContaining({
                url: 'https://new1.com',
                index: 0,
                status: 'pending'
            }));
            expect(savedJob.urls[1]).toEqual(expect.objectContaining({
                url: 'https://new2.com',
                index: 1,
                status: 'pending'
            }));
            expect(savedJob.urlResults).toEqual({}); // reset
        });

        test('should preserve pre-set status on URLs', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                urls: [],
                urlResults: {}
            });

            const newUrls = [
                { url: 'https://a.com', status: 'complete' }
            ];

            await jobStorage.replaceJobUrls('job-123', newUrls);

            const savedJob = mockStore.setJSON.mock.calls[0][1];
            expect(savedJob.urls[0].status).toBe('complete');
        });

        test('should throw when job not found', async () => {
            mockStore.get.mockResolvedValue(null);

            await expect(jobStorage.replaceJobUrls('job-missing', []))
                .rejects.toThrow('Job job-missing not found');
        });
    });

    describe('addUrlToJob', () => {
        test('should add URL with next index', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                urls: [
                    { index: 0, url: 'https://a.com', status: 'complete' },
                    { index: 1, url: 'https://b.com', status: 'pending' }
                ]
            });

            const newIndex = await jobStorage.addUrlToJob('job-123', {
                url: 'https://c.com'
            });

            expect(newIndex).toBe(2);
            const savedJob = mockStore.setJSON.mock.calls[0][1];
            expect(savedJob.urls).toHaveLength(3);
            expect(savedJob.urls[2]).toEqual(expect.objectContaining({
                url: 'https://c.com',
                index: 2,
                status: 'pending'
            }));
        });

        test('should add URL to empty urls array', async () => {
            mockStore.get.mockResolvedValue({
                jobId: 'job-123',
                urls: []
            });

            const newIndex = await jobStorage.addUrlToJob('job-123', {
                url: 'https://first.com'
            });

            expect(newIndex).toBe(0);
        });

        test('should throw when job not found', async () => {
            mockStore.get.mockResolvedValue(null);

            await expect(jobStorage.addUrlToJob('job-missing', { url: 'https://a.com' }))
                .rejects.toThrow('Job job-missing not found');
        });
    });

    describe('cleanupOldJobs', () => {
        test('should delete old completed jobs', async () => {
            const oldCompletedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago

            mockStore.list.mockResolvedValue({
                blobs: [{ key: 'job-old' }]
            });
            mockStore.get.mockResolvedValue({
                jobId: 'job-old',
                status: 'complete',
                completedAt: oldCompletedAt
            });

            // cleanupOldJobs is called internally by createJob
            await jobStorage.createJob('Test', 'Model');

            // Should have deleted the old job
            expect(mockStore.delete).toHaveBeenCalledWith('job-old');
        });

        test('should not delete active jobs', async () => {
            mockStore.list.mockResolvedValue({
                blobs: [{ key: 'job-active' }]
            });
            mockStore.get
                .mockResolvedValueOnce({ // First call: for cleanup list
                    jobId: 'job-active',
                    status: 'analyzing',
                    completedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
                });

            await jobStorage.createJob('Test', 'Model');

            // Should NOT delete active job
            expect(mockStore.delete).not.toHaveBeenCalledWith('job-active');
        });

        test('should not delete recent completed jobs', async () => {
            const recentCompletedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 minutes ago

            mockStore.list.mockResolvedValue({
                blobs: [{ key: 'job-recent' }]
            });
            mockStore.get
                .mockResolvedValueOnce({
                    jobId: 'job-recent',
                    status: 'complete',
                    completedAt: recentCompletedAt
                });

            await jobStorage.createJob('Test', 'Model');

            expect(mockStore.delete).not.toHaveBeenCalledWith('job-recent');
        });

        test('should not delete jobs without completedAt', async () => {
            mockStore.list.mockResolvedValue({
                blobs: [{ key: 'job-no-timestamp' }]
            });
            mockStore.get
                .mockResolvedValueOnce({
                    jobId: 'job-no-timestamp',
                    status: 'complete',
                    completedAt: null
                });

            await jobStorage.createJob('Test', 'Model');

            expect(mockStore.delete).not.toHaveBeenCalledWith('job-no-timestamp');
        });

        test('should handle errors during cleanup gracefully', async () => {
            mockStore.list.mockRejectedValue(new Error('Storage unavailable'));

            // Should not throw — cleanup errors are non-fatal
            const jobId = await jobStorage.createJob('Test', 'Model');

            expect(jobId).toMatch(/^job_/);
        });

        test('should handle 403 errors on individual blobs', async () => {
            mockStore.list.mockResolvedValue({
                blobs: [{ key: 'job-forbidden' }]
            });
            mockStore.get.mockImplementation((key) => {
                if (key === 'job-forbidden') {
                    const error = new Error('Forbidden');
                    error.statusCode = 403;
                    throw error;
                }
                return null;
            });

            // Should not throw
            const jobId = await jobStorage.createJob('Test', 'Model');
            expect(jobId).toMatch(/^job_/);
        });

        test('should handle 404 during delete (race condition)', async () => {
            const oldCompletedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
            mockStore.list.mockResolvedValue({
                blobs: [{ key: 'job-race' }]
            });
            mockStore.get.mockResolvedValue({
                jobId: 'job-race',
                status: 'complete',
                completedAt: oldCompletedAt
            });
            mockStore.delete.mockImplementation((key) => {
                if (key === 'job-race') {
                    const error = new Error('Not found');
                    error.statusCode = 404;
                    throw error;
                }
            });

            // Should not throw — race condition handled
            const jobId = await jobStorage.createJob('Test', 'Model');
            expect(jobId).toMatch(/^job_/);
        });

        test('should delete old error jobs too', async () => {
            const oldCompletedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
            mockStore.list.mockResolvedValue({
                blobs: [{ key: 'job-errored' }]
            });
            mockStore.get.mockResolvedValue({
                jobId: 'job-errored',
                status: 'error',
                completedAt: oldCompletedAt
            });

            await jobStorage.createJob('Test', 'Model');

            expect(mockStore.delete).toHaveBeenCalledWith('job-errored');
        });
    });
});
