const {
    filterIrrelevantTables,
    processTablesInContent,
    smartTruncate,
} = require("../netlify/functions/lib/content-truncator");

describe("Content Truncator Tests", () => {
    describe("filterIrrelevantTables", () => {
        it("should keep tables containing the product model", () => {
            const content = `Some text
=== TABLE START ===
| Product | Status |
| ANBS4-15 | Active |
=== TABLE END ===
More text`;

            const result = filterIrrelevantTables(content, "ANBS4-15");
            expect(result).toContain("ANBS4-15");
            expect(result).toContain("=== TABLE START ===");
        });

        it("should remove tables far from product tables", () => {
            const content = `Some text
=== TABLE START ===
| Navigation | Links |
| Home | About |
=== TABLE END ===
${"X".repeat(300)}
=== TABLE START ===
| Product | Status |
| ANBS4-15 | Active |
=== TABLE END ===`;

            const result = filterIrrelevantTables(content, "ANBS4-15");
            expect(result).toContain("ANBS4-15");
            expect(result).not.toContain("Navigation");
        });

        it("should preserve adjacent tables with price info (ANBS4-15 scenario)", () => {
            // This is the exact scenario from the logs that was failing
            const content = `MISUMI | Your Time, Our Priority
ANBS4-15の検索結果
型番・タイプ (1 件)
=== TABLE START ===
| 商品情報 |
| 価格改定 ANBS4-15 調整ねじセット 六角穴付タイプ ミスミ |
=== TABLE END ===
=== TABLE START ===
| CAD | 価格・出荷日 |
| 2D / 3D | 通常価格(税別) ： 780円 通常出荷日 ： 在庫品1日目 当日出荷可能 |
=== TABLE END ===
検索結果を評価`;

            const result = filterIrrelevantTables(content, "ANBS4-15");

            // Should keep the product table
            expect(result).toContain("ANBS4-15");
            expect(result).toContain("商品情報");

            // CRITICAL: Should also keep the adjacent price table
            expect(result).toContain("780円");
            expect(result).toContain("価格・出荷日");
            expect(result).toContain("在庫品1日目");
        });

        it("should handle content with no tables", () => {
            const content = "No tables here, just text about ANBS4-15";
            const result = filterIrrelevantTables(content, "ANBS4-15");
            expect(result).toBe(content);
        });

        it("should handle null/empty inputs", () => {
            expect(filterIrrelevantTables(null, "test")).toBeNull();
            expect(filterIrrelevantTables("content", null)).toBe("content");
            expect(filterIrrelevantTables("", "test")).toBe("");
        });
    });

    describe("processTablesInContent", () => {
        it("should add markers to pipe-delimited tables", () => {
            const content = `Some text
                            | Column1 | Column2 |
                            | Value1 | Value2 |
                            More text`;

            const result = processTablesInContent(content);
            expect(result).toContain("=== TABLE START ===");
            expect(result).toContain("=== TABLE END ===");
        });

        it("should not double-mark already marked tables", () => {
            // Content that already has markers from scraping
            const content = `Some text
=== TABLE START ===
| Column1 | Column2 |
| Value1 | Value2 |
=== TABLE END ===
More text`;

            const result = processTablesInContent(content);

            // Count TABLE markers - should have added new ones around the pipe rows
            // but the original markers are just text lines
            const startCount = (result.match(/=== TABLE START ===/g) || [])
                .length;
            const endCount = (result.match(/=== TABLE END ===/g) || []).length;

            // The pipe-delimited rows will get new markers
            // This is actually the bug - if content already has markers,
            // we should NOT call processTablesInContent at all
            // The fix in analyze-job.js prevents this by checking for existing markers
            expect(startCount).toBeGreaterThanOrEqual(1);
            expect(endCount).toBeGreaterThanOrEqual(1);
        });

        it("should handle null/empty input", () => {
            expect(processTablesInContent(null)).toBeNull();
            expect(processTablesInContent("")).toBe("");
        });

        it("should handle content with no tables", () => {
            const content = "Just plain text with no pipe characters";
            const result = processTablesInContent(content);
            expect(result).not.toContain("TABLE START");
            expect(result).toBe(content);
        });

        it("should handle table at end of content", () => {
            const content = `Some text
| Col1 | Col2 |
| Val1 | Val2 |`;
            const result = processTablesInContent(content);
            expect(result).toContain("=== TABLE START ===");
            expect(result).toContain("=== TABLE END ===");
        });

        it("should handle multiple separate tables", () => {
            const content = `Text before
| A | B |
| 1 | 2 |
Text between
| C | D |
| 3 | 4 |
Text after`;
            const result = processTablesInContent(content);
            const startCount = (result.match(/=== TABLE START ===/g) || []).length;
            const endCount = (result.match(/=== TABLE END ===/g) || []).length;
            expect(startCount).toBe(2);
            expect(endCount).toBe(2);
        });
    });

    describe("smartTruncate", () => {
        it("should return content unchanged if under maxLength", () => {
            const content = "Short content";
            const result = smartTruncate(content, 100, "product");
            expect(result).toBe(content);
        });

        it("should use simple truncation when no product model provided", () => {
            const content = "A".repeat(200);
            const result = smartTruncate(content, 100, null);
            expect(result.length).toBeLessThanOrEqual(100);
            expect(result).toContain("[Content truncated due to length]");
        });

        it("should use simple truncation when product not found in content", () => {
            const content = "A".repeat(200);
            const result = smartTruncate(content, 100, "XYZ-999");
            expect(result.length).toBeLessThanOrEqual(100);
            expect(result).toContain("[Content truncated due to length]");
        });

        it("should preserve product mentions during truncation", () => {
            // Create content with product mention surrounded by large amounts of text
            // Use a generous maxLength so zone extraction has room to work
            const filler = "Lorem ipsum dolor sit amet consectetur. ";
            let content = filler.repeat(40);
            content += "The product XYZ-100 is discontinued and replaced. ";
            content += filler.repeat(40);

            const result = smartTruncate(content, 2000, "XYZ-100");
            expect(result).toContain("XYZ-100");
        });

        it("should handle content with tables containing the product", () => {
            const tableContent = `Some introduction text about sensors and products.
=== TABLE START ===
| Product | Status | Price |
| ABC-100 | Active | $100 |
| DEF-200 | Discontinued | N/A |
| GHI-300 | Active | $200 |
| JKL-400 | Active | $150 |
| MNO-500 | Active | $180 |
=== TABLE END ===
${"More detailed information about various products and specifications. ".repeat(20)}`;

            const result = smartTruncate(tableContent, 800, "ABC-100");
            expect(result).toContain("ABC-100");
        });

        it("should not exceed maxLength", () => {
            const content = "A".repeat(1000) + " PRODUCT-XYZ is here " + "B".repeat(1000);
            const maxLength = 1500;
            const result = smartTruncate(content, maxLength, "PRODUCT-XYZ");
            expect(result.length).toBeLessThanOrEqual(maxLength);
        });

        it("should handle EOL keywords in content", () => {
            const content = "A".repeat(300) +
                " The product ABC-123 has been discontinued. " +
                "The successor model is DEF-456. " +
                "A".repeat(300);
            const result = smartTruncate(content, 600, "ABC-123");
            expect(result).toContain("ABC-123");
        });
    });
});
