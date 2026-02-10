// CJS wrapper for pdfjs-dist ESM module
// pdfjs-dist v4+ only ships .mjs (ESM) files, which cannot be loaded via require().
// This wrapper uses dynamic import() and caches the result for reuse.

let pdfjsModule = null;

async function loadPdfjs() {
    if (!pdfjsModule) {
        pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return pdfjsModule;
}

module.exports = { loadPdfjs };
