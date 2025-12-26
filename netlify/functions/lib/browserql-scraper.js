const logger = require('./logger');

/**
 * BrowserQL Scraper - Shared utility for Cloudflare-protected sites
 *
 * BrowserQL is used selectively because:
 * - Limited to 1000 tokens/month (1 token = 30 seconds)
 * - Can bypass Cloudflare protection
 * - Cannot use custom proxies (browserless.io proxy is too expensive)
 *
 * Use this ONLY when Cloudflare protection needs to be circumvented.
 * For other sites, use Puppeteer (render scraping service) which is "free indefinitely".
 */

/**
 * Scrape URL using BrowserQL (for Cloudflare-protected sites)
 * This is a synchronous scraping method that returns content directly
 *
 * @param {string} url - URL to scrape
 * @returns {Promise<{content: string, title: string|null, success: boolean}>} Scraped content
 * @throws {Error} If BROWSERQL_API_KEY is not set or scraping fails
 */
async function scrapeWithBrowserQL(url) {
    const browserqlApiKey = process.env.BROWSERQL_API_KEY;

    if (!browserqlApiKey) {
        throw new Error('BROWSERQL_API_KEY environment variable not set');
    }

    logger.info(`Scraping with BrowserQL: ${url}`);

    // Escape URL for GraphQL to prevent injection
    const escapedUrl = url
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');

    // BrowserQL GraphQL mutation using evaluate() to match Render's extraction
    // This uses the exact same JavaScript code as the Render scraping service
    // Note: waitUntil is an enum (not quoted), url is a string (quoted)
    const query = `
        mutation ScrapeUrl {
            goto(
                url: "${escapedUrl}"
                waitUntil: networkIdle
            ) {
                status
            }

            pageContent: evaluate(content: """
                (() => {
                    try {
                        const scripts = document.querySelectorAll('script, style, noscript');
                        scripts.forEach(el => el.remove());
                        return JSON.stringify({ text: document.body.innerText, error: null });
                    } catch (e) {
                        return JSON.stringify({ text: null, error: e?.message ?? String(e) });
                    }
                })()
            """) {
                value
            }
        }
    `;

    // Use stealth endpoint with token as query parameter (not Authorization header)
    const response = await fetch(`https://production-sfo.browserless.io/stealth/bql?token=${browserqlApiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            query
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`BrowserQL API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (result.errors) {
        throw new Error(`BrowserQL GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    if (!result.data?.pageContent) {
        throw new Error('BrowserQL returned no data');
    }

    // Parse the JSON-wrapped response from evaluate()
    const evaluateResult = JSON.parse(result.data.pageContent.value);

    if (evaluateResult.error) {
        throw new Error(`BrowserQL evaluation error: ${evaluateResult.error}`);
    }

    const content = evaluateResult.text;
    const title = null; // Can extract title separately if needed

    if (!content) {
        throw new Error('BrowserQL returned empty content');
    }

    logger.info(`BrowserQL scraped successfully: ${content.length} characters`);

    return {
        content,
        title,
        success: true
    };
}

module.exports = {
    scrapeWithBrowserQL
};
