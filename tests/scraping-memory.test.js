// Mock the scraping service logger
jest.mock('../scraping-service/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Fresh require for each test to reset module state
let memory;

beforeEach(() => {
    // Clear module cache to reset internal state (memoryHistory, requestCount, isShuttingDown)
    jest.resetModules();
    jest.mock('../scraping-service/utils/logger', () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    }));
    memory = require('../scraping-service/utils/memory');
});

describe('Scraping Service - Memory Management', () => {

    describe('constants', () => {
        it('should have a MEMORY_LIMIT_MB of 450', () => {
            expect(memory.MEMORY_LIMIT_MB).toBe(450);
        });

        it('should have a MEMORY_WARNING_MB of 380', () => {
            expect(memory.MEMORY_WARNING_MB).toBe(380);
        });
    });

    describe('getMemoryUsageMB', () => {
        it('should return an object with rss, heapUsed, heapTotal, and external', () => {
            const usage = memory.getMemoryUsageMB();
            expect(usage).toHaveProperty('rss');
            expect(usage).toHaveProperty('heapUsed');
            expect(usage).toHaveProperty('heapTotal');
            expect(usage).toHaveProperty('external');
        });

        it('should return numeric values', () => {
            const usage = memory.getMemoryUsageMB();
            expect(typeof usage.rss).toBe('number');
            expect(typeof usage.heapUsed).toBe('number');
            expect(typeof usage.heapTotal).toBe('number');
            expect(typeof usage.external).toBe('number');
        });

        it('should return values in MB (reasonable range)', () => {
            const usage = memory.getMemoryUsageMB();
            // The test process should use at least 1MB and less than 2GB
            expect(usage.rss).toBeGreaterThan(0);
            expect(usage.rss).toBeLessThan(2000);
        });
    });

    describe('trackMemoryUsage', () => {
        it('should return current memory usage', () => {
            const result = memory.trackMemoryUsage('test-stage');
            expect(result).toHaveProperty('rss');
            expect(result).toHaveProperty('heapUsed');
        });

        it('should add to memory history', () => {
            memory.trackMemoryUsage('stage-1');
            memory.trackMemoryUsage('stage-2');
            const history = memory.getMemoryHistory();
            expect(history.length).toBe(2);
        });

        it('should cap history at 20 entries', () => {
            for (let i = 0; i < 25; i++) {
                memory.trackMemoryUsage(`stage-${i}`);
            }
            const history = memory.getMemoryHistory();
            expect(history.length).toBe(20);
        });

        it('should include stage name and timestamp in history entries', () => {
            memory.trackMemoryUsage('my-stage');
            const history = memory.getMemoryHistory();
            expect(history[0].stage).toBe('my-stage');
            expect(history[0].timestamp).toBeDefined();
        });
    });

    describe('shouldRestartDueToMemory', () => {
        it('should return false when memory is below limit', () => {
            // In a test process, memory should be well below 450MB
            expect(memory.shouldRestartDueToMemory()).toBe(false);
        });
    });

    describe('shutdown state', () => {
        it('should initially be false', () => {
            expect(memory.getShutdownState()).toBe(false);
        });

        it('should be settable to true', () => {
            memory.setShutdownState(true);
            expect(memory.getShutdownState()).toBe(true);
        });

        it('should be settable back to false', () => {
            memory.setShutdownState(true);
            memory.setShutdownState(false);
            expect(memory.getShutdownState()).toBe(false);
        });
    });

    describe('request counter', () => {
        it('should start at 0', () => {
            expect(memory.getRequestCount()).toBe(0);
        });

        it('should increment correctly', () => {
            const count1 = memory.incrementRequestCount();
            expect(count1).toBe(1);

            const count2 = memory.incrementRequestCount();
            expect(count2).toBe(2);
        });

        it('should return correct count via getter', () => {
            memory.incrementRequestCount();
            memory.incrementRequestCount();
            memory.incrementRequestCount();
            expect(memory.getRequestCount()).toBe(3);
        });
    });

    describe('forceGarbageCollection', () => {
        it('should not throw when gc is not exposed', () => {
            // In normal test runs, global.gc is not available
            expect(() => memory.forceGarbageCollection()).not.toThrow();
        });
    });

    describe('getMemoryHistory', () => {
        it('should return empty array initially', () => {
            expect(memory.getMemoryHistory()).toEqual([]);
        });
    });
});
