/**
 * optimize-avif.ts
 *
 * AVIF compression testing script
 *
 * Features:
 * - Tests multiple quality/effort combinations
 * - Generates detailed comparison reports
 * - Creates visual comparison HTML
 * - Parallel processing for speed
 * - Progress tracking
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

// Configuration
const IMAGES_DIR = path.join(process.cwd(), 'public', 'images');
const OUTPUT_DIR = path.join(process.cwd(), '.optimization-test-output');
const CONCURRENCY_LIMIT = 4;

// Files to process
const LANDING_FRAMES = Array.from({ length: 23 }, (_, i) => `landing-${i + 1}.avif`);
const LOGO_FILE = 'lash-her-gold.avif';
const ALL_FILES = [...LANDING_FRAMES, LOGO_FILE];

// Test matrix - focused on quality range user cares about
const TEST_MATRIX = [
  { quality: 85, effort: 9, label: 'Near Lossless' },
  { quality: 82, effort: 9, label: 'Excellent+' },
  { quality: 80, effort: 9, label: 'Excellent (Recommended)' },
  { quality: 78, effort: 9, label: 'Very Good+' },
  { quality: 75, effort: 9, label: 'Very Good' },
  { quality: 70, effort: 9, label: 'Good' },
  { quality: 80, effort: 6, label: 'Fast Encoding' },
];

interface FileResult {
  filename: string;
  originalSize: number;
  compressedSize: number;
  reduction: string;
  compressionTime: number;
}

interface TestResult {
  quality: number;
  effort: number;
  label: string;
  totalSize: number;
  averageSizeReduction: string;
  totalSavings: number;
  totalTime: number;
  files: FileResult[];
}

interface TestReport {
  testDate: string;
  originalStats: {
    totalFiles: number;
    totalSize: number;
    averageSize: number;
  };
  compressionTests: TestResult[];
  recommendations: {
    quality: number;
    effort: number;
    label: string;
    reason: string;
    totalSizeEstimate: number;
    savings: number;
  }[];
}

/**
 * Process files in batches with concurrency limit
 */
async function processInBatches<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  batchSize: number
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Compress a single file with specified settings
 */
async function compressFile(
  filename: string,
  quality: number,
  effort: number,
  outputDir: string
): Promise<FileResult> {
  const inputPath = path.join(IMAGES_DIR, filename);
  const outputPath = path.join(outputDir, filename);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  const originalSize = fs.statSync(inputPath).size;
  const startTime = Date.now();

  // Compress with Sharp
  await sharp(inputPath)
    .avif({
      quality,
      effort,
      chromaSubsampling: '4:4:4', // Full chroma for maximum quality
      lossless: false,
    })
    .toFile(outputPath);

  const compressionTime = Date.now() - startTime;
  const compressedSize = fs.statSync(outputPath).size;
  const reduction = (((originalSize - compressedSize) / originalSize) * 100).toFixed(1);

  return {
    filename,
    originalSize,
    compressedSize,
    reduction: `${reduction}%`,
    compressionTime,
  };
}

/**
 * Run compression test for a specific quality/effort combination
 */
async function runCompressionTest(
  quality: number,
  effort: number,
  label: string
): Promise<TestResult> {
  const dirName = `quality-${quality}-effort-${effort}`;
  const outputDir = path.join(OUTPUT_DIR, dirName);

  console.log(`\nTesting: ${label} (Quality ${quality}, Effort ${effort})`);
  console.log(`Output: ${dirName}/`);

  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const startTime = Date.now();

  // Process all files in batches
  const results = await processInBatches(
    ALL_FILES,
    (filename) => compressFile(filename, quality, effort, outputDir),
    CONCURRENCY_LIMIT
  );

  const totalTime = Date.now() - startTime;

  // Calculate statistics
  const totalSize = results.reduce((sum, r) => sum + r.compressedSize, 0);
  const totalOriginalSize = results.reduce((sum, r) => sum + r.originalSize, 0);
  const totalSavings = totalOriginalSize - totalSize;
  const averageSizeReduction = (((totalOriginalSize - totalSize) / totalOriginalSize) * 100).toFixed(1);

  console.log(`✓ Completed in ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`  Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Average reduction: ${averageSizeReduction}%`);

  return {
    quality,
    effort,
    label,
    totalSize,
    averageSizeReduction: `${averageSizeReduction}%`,
    totalSavings,
    totalTime,
    files: results,
  };
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(report: TestReport): string {
  const { originalStats, compressionTests, recommendations } = report;

  let markdown = `# AVIF Optimization Test Report\n\n`;
  markdown += `Generated: ${new Date(report.testDate).toLocaleString()}\n\n`;

  markdown += `## Original Files\n\n`;
  markdown += `- Total Files: ${originalStats.totalFiles}\n`;
  markdown += `- Total Size: ${(originalStats.totalSize / 1024 / 1024).toFixed(2)} MB\n`;
  markdown += `- Average Size: ${(originalStats.averageSize / 1024).toFixed(0)} KB\n\n`;

  markdown += `## Test Results Summary\n\n`;
  markdown += `| Quality | Effort | Total Size | Reduction | Avg Size | Time | Status |\n`;
  markdown += `|---------|--------|------------|-----------|----------|------|--------|\n`;

  compressionTests.forEach((test) => {
    const sizeInMB = (test.totalSize / 1024 / 1024).toFixed(2);
    const avgSize = (test.totalSize / originalStats.totalFiles / 1024).toFixed(0);
    const timeInSec = (test.totalTime / 1000).toFixed(1);
    let status = '';

    if (test.label.includes('Recommended')) {
      status = '✅ Recommended';
    } else if (test.quality >= 82) {
      status = '⭐ High Quality';
    } else if (test.quality >= 75) {
      status = '⚠️ Quality Check';
    } else {
      status = '⚠️ Lower Quality';
    }

    markdown += `| ${test.quality} | ${test.effort} | ${sizeInMB} MB | ${test.averageSizeReduction} | ${avgSize} KB | ${timeInSec}s | ${status} |\n`;
  });

  markdown += `\n## Recommendations\n\n`;
  recommendations.forEach((rec, i) => {
    markdown += `${i + 1}. **${rec.label}** (Quality ${rec.quality}, Effort ${rec.effort})\n`;
    markdown += `   - Reason: ${rec.reason}\n`;
    markdown += `   - Total Size: ${(rec.totalSizeEstimate / 1024 / 1024).toFixed(2)} MB\n`;
    markdown += `   - Savings: ${(rec.savings / 1024 / 1024).toFixed(2)} MB\n\n`;
  });

  markdown += `## Detailed File-by-File Results\n\n`;
  compressionTests.forEach((test) => {
    markdown += `### ${test.label} (Quality ${test.quality}, Effort ${test.effort})\n\n`;
    markdown += `| File | Original | Compressed | Reduction | Time |\n`;
    markdown += `|------|----------|------------|-----------|------|\n`;

    test.files.forEach((file) => {
      const origKB = (file.originalSize / 1024).toFixed(0);
      const compKB = (file.compressedSize / 1024).toFixed(0);
      const time = file.compressionTime;

      markdown += `| ${file.filename} | ${origKB} KB | ${compKB} KB | ${file.reduction} | ${time}ms |\n`;
    });

    markdown += `\n`;
  });

  markdown += `## Next Steps\n\n`;
  markdown += `1. Review the visual comparison: \`open .optimization-test-output/comparison.html\`\n`;
  markdown += `2. Choose your preferred quality level from the table above\n`;
  markdown += `3. Apply optimization: \`npm run optimize:apply -- --quality=80 --effort=9\`\n`;
  markdown += `4. Re-upload to Vercel Blob: \`npm run migrate:blob\`\n`;
  markdown += `5. Clean up test files: \`npm run optimize:cleanup\`\n`;

  return markdown;
}

/**
 * Generate HTML comparison tool
 */
function generateComparisonHTML(report: TestReport): string {
  const { originalStats, compressionTests } = report;

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AVIF Optimization Comparison</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #f5f5f5;
      padding: 20px;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
    }
    .stats {
      background: white;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .stats p { margin: 5px 0; }
    .comparison-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      margin-bottom: 40px;
    }
    .image-card {
      background: white;
      border-radius: 8px;
      padding: 15px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .image-card h3 {
      font-size: 14px;
      margin-bottom: 10px;
      color: #555;
    }
    .image-card img {
      width: 100%;
      height: auto;
      border-radius: 4px;
    }
    .recommended {
      border: 2px solid #4CAF50;
    }
    .section {
      margin-bottom: 50px;
    }
  </style>
</head>
<body>
  <h1>AVIF Optimization Visual Comparison</h1>
  <div class="stats">
    <p><strong>Original Files:</strong> ${originalStats.totalFiles} files, ${(originalStats.totalSize / 1024 / 1024).toFixed(2)} MB total</p>
    <p><strong>Generated:</strong> ${new Date(report.testDate).toLocaleString()}</p>
  </div>
`;

  // Show first 3 frames as examples
  const exampleFrames = ['landing-1.avif', 'landing-12.avif', 'lash-her-gold.avif'];

  exampleFrames.forEach((filename) => {
    html += `<div class="section">
    <h2>Comparison: ${filename}</h2>
    <div class="comparison-grid">
      <div class="image-card">
        <h3>Original (${(originalStats.totalSize / originalStats.totalFiles / 1024).toFixed(0)} KB avg)</h3>
        <img src="../public/images/${filename}" alt="Original ${filename}">
      </div>
`;

    compressionTests.forEach((test) => {
      const dirName = `quality-${test.quality}-effort-${test.effort}`;
      const fileResult = test.files.find((f) => f.filename === filename);
      const compressedKB = fileResult ? (fileResult.compressedSize / 1024).toFixed(0) : 'N/A';
      const reduction = fileResult ? fileResult.reduction : 'N/A';
      const isRecommended = test.label.includes('Recommended');

      html += `      <div class="image-card${isRecommended ? ' recommended' : ''}">
        <h3>${test.label} (${compressedKB} KB, ${reduction} reduction)</h3>
        <img src="${dirName}/${filename}" alt="${test.label} ${filename}">
      </div>
`;
    });

    html += `    </div>
  </div>
`;
  });

  html += `  <div class="stats">
    <p><strong>Tip:</strong> Open images in new tabs to compare at 100% zoom</p>
    <p><strong>Recommended:</strong> Green border indicates recommended settings (Quality 80, Effort 9)</p>
  </div>
</body>
</html>`;

  return html;
}

/**
 * Main function
 */
async function runOptimizationTests(): Promise<void> {
  console.log('\n🔬 Starting AVIF Optimization Tests\n');
  console.log(`Source directory: ${IMAGES_DIR}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
  console.log(`Files to process: ${ALL_FILES.length}`);
  console.log(`Test combinations: ${TEST_MATRIX.length}\n`);

  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Calculate original statistics
  let totalOriginalSize = 0;
  ALL_FILES.forEach((filename) => {
    const filePath = path.join(IMAGES_DIR, filename);
    if (fs.existsSync(filePath)) {
      totalOriginalSize += fs.statSync(filePath).size;
    }
  });

  const originalStats = {
    totalFiles: ALL_FILES.length,
    totalSize: totalOriginalSize,
    averageSize: totalOriginalSize / ALL_FILES.length,
  };

  console.log(`Original total size: ${(totalOriginalSize / 1024 / 1024).toFixed(2)} MB\n`);

  // Run all compression tests
  const compressionTests: TestResult[] = [];

  for (const test of TEST_MATRIX) {
    const result = await runCompressionTest(test.quality, test.effort, test.label);
    compressionTests.push(result);
  }

  // Generate recommendations
  const recommendations = [
    {
      quality: 80,
      effort: 9,
      label: 'Excellent (Recommended)',
      reason: 'Best balance: significant size reduction with excellent visual quality',
      totalSizeEstimate: compressionTests.find((t) => t.quality === 80 && t.effort === 9)!.totalSize,
      savings: totalOriginalSize - compressionTests.find((t) => t.quality === 80 && t.effort === 9)!.totalSize,
    },
    {
      quality: 85,
      effort: 9,
      label: 'Near Lossless',
      reason: 'Maximum quality with minimal compression',
      totalSizeEstimate: compressionTests.find((t) => t.quality === 85 && t.effort === 9)!.totalSize,
      savings: totalOriginalSize - compressionTests.find((t) => t.quality === 85 && t.effort === 9)!.totalSize,
    },
    {
      quality: 75,
      effort: 9,
      label: 'Very Good',
      reason: 'Aggressive compression with very good quality (check visuals)',
      totalSizeEstimate: compressionTests.find((t) => t.quality === 75 && t.effort === 9)!.totalSize,
      savings: totalOriginalSize - compressionTests.find((t) => t.quality === 75 && t.effort === 9)!.totalSize,
    },
  ];

  const report: TestReport = {
    testDate: new Date().toISOString(),
    originalStats,
    compressionTests,
    recommendations,
  };

  // Save JSON report
  const jsonPath = path.join(OUTPUT_DIR, 'optimization-report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\n✓ Saved JSON report: ${jsonPath}`);

  // Save markdown report
  const markdownPath = path.join(OUTPUT_DIR, 'optimization-report.md');
  const markdown = generateMarkdownReport(report);
  fs.writeFileSync(markdownPath, markdown);
  console.log(`✓ Saved Markdown report: ${markdownPath}`);

  // Save HTML comparison
  const htmlPath = path.join(OUTPUT_DIR, 'comparison.html');
  const html = generateComparisonHTML(report);
  fs.writeFileSync(htmlPath, html);
  console.log(`✓ Saved HTML comparison: ${htmlPath}`);

  console.log('\n✅ Optimization tests complete!\n');
  console.log('Next steps:');
  console.log('1. Review the markdown report:');
  console.log(`   cat ${markdownPath}`);
  console.log('2. View visual comparison:');
  console.log(`   open ${htmlPath}`);
  console.log('3. Apply your chosen settings:');
  console.log('   npm run optimize:apply -- --quality=80 --effort=9');
  console.log('4. Clean up when done:');
  console.log('   npm run optimize:cleanup\n');
}

// Execute
runOptimizationTests()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Optimization tests failed:', error);
    process.exit(1);
  });
