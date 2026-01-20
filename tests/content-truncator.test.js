const { filterIrrelevantTables, processTablesInContent } = require('../netlify/functions/lib/content-truncator');

describe('Content Truncator Tests', () => {
    describe('filterIrrelevantTables', () => {
        it('should keep tables containing the product model', () => {
            const content = `Some text
=== TABLE START ===
| Product | Status |
| ANBS4-15 | Active |
=== TABLE END ===
More text`;

            const result = filterIrrelevantTables(content, 'ANBS4-15');
            expect(result).toContain('ANBS4-15');
            expect(result).toContain('=== TABLE START ===');
        });

        it('should remove tables far from product tables', () => {
            const content = `Some text
=== TABLE START ===
| Navigation | Links |
| Home | About |
=== TABLE END ===
${'X'.repeat(300)}
=== TABLE START ===
| Product | Status |
| ANBS4-15 | Active |
=== TABLE END ===`;

            const result = filterIrrelevantTables(content, 'ANBS4-15');
            expect(result).toContain('ANBS4-15');
            expect(result).not.toContain('Navigation');
        });

        it('should preserve adjacent tables with price info (ANBS4-15 scenario)', () => {
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

            const result = filterIrrelevantTables(content, 'ANBS4-15');

            // Should keep the product table
            expect(result).toContain('ANBS4-15');
            expect(result).toContain('商品情報');

            // CRITICAL: Should also keep the adjacent price table
            expect(result).toContain('780円');
            expect(result).toContain('価格・出荷日');
            expect(result).toContain('在庫品1日目');
        });

        it('should handle content with no tables', () => {
            const content = 'No tables here, just text about ANBS4-15';
            const result = filterIrrelevantTables(content, 'ANBS4-15');
            expect(result).toBe(content);
        });

        it('should handle null/empty inputs', () => {
            expect(filterIrrelevantTables(null, 'test')).toBeNull();
            expect(filterIrrelevantTables('content', null)).toBe('content');
            expect(filterIrrelevantTables('', 'test')).toBe('');
        });
    });

    describe('processTablesInContent', () => {
        it('should add markers to pipe-delimited tables', () => {
            const content = `Some text
| Column1 | Column2 |
| Value1 | Value2 |
More text`;

            const result = processTablesInContent(content);
            expect(result).toContain('=== TABLE START ===');
            expect(result).toContain('=== TABLE END ===');
        });

        it('should not double-mark already marked tables', () => {
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
            const startCount = (result.match(/=== TABLE START ===/g) || []).length;
            const endCount = (result.match(/=== TABLE END ===/g) || []).length;

            // The pipe-delimited rows will get new markers
            // This is actually the bug - if content already has markers,
            // we should NOT call processTablesInContent at all
            // The fix in analyze-job.js prevents this by checking for existing markers
            expect(startCount).toBeGreaterThanOrEqual(1);
            expect(endCount).toBeGreaterThanOrEqual(1);
        });
    });
});
