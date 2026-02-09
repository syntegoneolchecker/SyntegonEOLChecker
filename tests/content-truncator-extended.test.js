/**
 * Extended tests for content-truncator.js
 * Targets uncovered lines: 120-121, 191, 226, 235, 243, 254-255, 285, 355, 525-527, 571
 * Focus: simpleTruncate edge cases, removeBoilerplate, removeDistantContent, zone extraction
 */

const {
    filterIrrelevantTables,
    processTablesInContent,
    smartTruncate,
} = require("../netlify/functions/lib/content-truncator");

// Suppress logger output during tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

describe("Content Truncator - Extended Tests", () => {

    describe("simpleTruncate (via smartTruncate with no product)", () => {
        test("should cut at sentence boundary when available", () => {
            const content = "First sentence. Second sentence. Third sentence. " + "A".repeat(200);
            const result = smartTruncate(content, 100, null);
            expect(result).toContain("[Content truncated due to length]");
            expect(result.length).toBeLessThanOrEqual(100);
        });

        test("should cut at newline boundary when no period found", () => {
            const content = "Line one\nLine two\n" + "A".repeat(200);
            const result = smartTruncate(content, 80, null);
            expect(result).toContain("[Content truncated due to length]");
            expect(result.length).toBeLessThanOrEqual(80);
        });

        test("should hard-truncate when no good boundary found", () => {
            // No periods or newlines in the first part
            const content = "A".repeat(500);
            const result = smartTruncate(content, 100, null);
            expect(result).toContain("[Content truncated due to length]");
            expect(result.length).toBeLessThanOrEqual(100);
        });
    });

    describe("smartTruncate - progressive reduction stages", () => {
        test("should return early after table truncation if within limit", () => {
            // Content with tables that can be truncated to fit
            const content = `Introduction about PROD-X.
=== TABLE START ===
| Product | Status |
| PROD-X | Active |
| Other1 | N/A |
| Other2 | N/A |
| Other3 | N/A |
| Other4 | N/A |
=== TABLE END ===
Brief ending about PROD-X.`;

            // Set maxLength large enough that table truncation alone brings it under
            const result = smartTruncate(content, 5000, "PROD-X");
            expect(result).toContain("PROD-X");
        });

        test("should apply whitespace removal when table truncation is not enough", () => {
            // Large content with excessive whitespace
            const spaces = " ".repeat(50);
            const newlines = "\n".repeat(10);
            let content = `Start content about WIDGET-99.${newlines}`;
            content += `Product WIDGET-99 information.${spaces}`;
            content += `More about WIDGET-99.${newlines}`;
            content += "A".repeat(300);

            const result = smartTruncate(content, 500, "WIDGET-99");
            expect(result).toContain("WIDGET-99");
        });

        test("should apply boilerplate removal for very long content", () => {
            let content = "Product SENSOR-42 is available.\n";
            content += "Copyright © 2024 Company Inc.\n";
            content += "All rights reserved.\n";
            content += "This site uses cookies to improve your experience.\n";
            content += "Home About Contact Products Services Support FAQ\n";
            content += "Facebook Twitter LinkedIn Instagram YouTube\n";
            content += "Terms Privacy Sitemap\n";
            // Pad to make it long enough to need truncation
            content += ("Product SENSOR-42 specifications and data. ").repeat(50);

            const result = smartTruncate(content, 800, "SENSOR-42");
            expect(result).toContain("SENSOR-42");
        });

        test("should apply zone extraction as last resort", () => {
            // Very long content with product mentions scattered
            let content = "A".repeat(2000);
            content += " The product MODEL-77 is discontinued. ";
            content += "B".repeat(2000);
            content += " MODEL-77 successor is MODEL-78. ";
            content += "C".repeat(2000);

            const result = smartTruncate(content, 1500, "MODEL-77");
            expect(result).toContain("MODEL-77");
            expect(result).toContain("[Content truncated to preserve product mentions]");
            expect(result.length).toBeLessThanOrEqual(1500);
        });

        test("should apply hard truncation when zone extraction still exceeds limit", () => {
            // Many product mentions creating large zones
            let content = "";
            for (let i = 0; i < 20; i++) {
                content += `Section ${i}: DEVICE-123 data here. ` + "X".repeat(200) + "\n";
            }

            const result = smartTruncate(content, 300, "DEVICE-123");
            expect(result.length).toBeLessThanOrEqual(300);
        });
    });

    describe("filterIrrelevantTables - adjacent table logic", () => {
        test("should keep table before product table when adjacent", () => {
            const content = `Text
=== TABLE START ===
| Header | Info |
| Category | Sensors |
=== TABLE END ===
=== TABLE START ===
| Product | Status |
| PROD-A | Active |
=== TABLE END ===`;

            const result = filterIrrelevantTables(content, "PROD-A");
            expect(result).toContain("Category");
            expect(result).toContain("PROD-A");
        });

        test("should keep table after product table when adjacent", () => {
            const content = `Text
=== TABLE START ===
| Product | Status |
| PROD-B | Discontinued |
=== TABLE END ===
=== TABLE START ===
| Successor | Price |
| PROD-C | $200 |
=== TABLE END ===`;

            const result = filterIrrelevantTables(content, "PROD-B");
            expect(result).toContain("PROD-B");
            expect(result).toContain("Successor");
            expect(result).toContain("PROD-C");
        });

        test("should remove all tables when none contain product", () => {
            const content = `Text
=== TABLE START ===
| Unrelated | Data |
| Foo | Bar |
=== TABLE END ===
End text`;

            const result = filterIrrelevantTables(content, "PROD-Z");
            expect(result).not.toContain("=== TABLE START ===");
            expect(result).toContain("Text");
            expect(result).toContain("End text");
        });
    });

    describe("processTablesInContent - edge cases", () => {
        test("should handle table separator lines within tables", () => {
            const content = `| Header1 | Header2 |
|---------|---------|
| Data1 | Data2 |`;

            const result = processTablesInContent(content);
            expect(result).toContain("=== TABLE START ===");
            expect(result).toContain("=== TABLE END ===");
            expect(result).toContain("|---------|---------|");
        });

        test("should handle single pipe line (not a table)", () => {
            const content = "This has a single | pipe but is not a table";
            const result = processTablesInContent(content);
            expect(result).not.toContain("TABLE START");
        });
    });

    describe("smartTruncate - keyword-based zone extraction", () => {
        test("should preserve EOL keywords near product mentions", () => {
            let content = "X".repeat(2000);
            content += " Product ABC-999 has been discontinued and is end of life. ";
            content += "The successor model is DEF-111. ";
            content += "X".repeat(2000);

            const result = smartTruncate(content, 1500, "ABC-999");
            expect(result).toContain("ABC-999");
        });

        test("should preserve Japanese EOL keywords", () => {
            let content = "X".repeat(2000);
            content += " 製品ABC-888は生産終了しました。代替品はDEF-222です。 ";
            content += "X".repeat(2000);

            const result = smartTruncate(content, 1500, "ABC-888");
            expect(result).toContain("ABC-888");
        });
    });
});
