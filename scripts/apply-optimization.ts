/**
 * apply-optimization.ts
 *
 * Apply chosen AVIF compression settings to production files
 *
 * Features:
 * - CLI interface for quality/effort parameters
 * - Automatic backup of original files
 * - Dry-run mode for safety
 * - File validation
 * - Size increase detection
 * - Rollback capability
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

// Configuration
const IMAGES_DIR = path.join(process.cwd(), 'public', 'images');
const BACKUP_DIR = path.join(process.cwd(), '.backups');
const TEMP_DIR = path.join(process.cwd(), '.temp-optimization');

// Files to process
const LANDING_FRAMES = Array.from({ length: 23 }, (_, i) => `landing-${i + 1}.avif`);
const LOGO_FILE = 'lash-her-gold.avif';
const ALL_FILES = [...LANDING_FRAMES, LOGO_FILE];

interface OptimizationResult {
  filename: string;
  originalSize: number;
  optimizedSize: number;
  reduction: string;
  skipped: boolean;
  skipReason?: string;
}

interface CliArgs {
  quality: number;
  effort: number;
  dryRun: boolean;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let quality = 80; // Default
  let effort = 9; // Default
  let dryRun = false;

  args.forEach((arg) => {
    if (arg.startsWith('--quality=')) {
      quality = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--effort=')) {
      effort = parseInt(arg.split('=')[1]);
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  });

  return { quality, effort, dryRun };
}

/**
 * Validate parameters
 */
function validateParams(quality: number, effort: number): void {
  if (quality < 1 || quality > 100) {
    throw new Error(`Invalid quality: ${quality}. Must be between 1 and 100.`);
  }

  if (effort < 0 || effort > 9) {
    throw new Error(`Invalid effort: ${effort}. Must be between 0 and 9.`);
  }

  if (quality < 60) {
    console.warn(`⚠️  Warning: Quality ${quality} is quite low and may result in visible artifacts.`);
  }
}

/**
 * Create timestamped backup directory
 */
function createBackup(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `images-${timestamp}`);

  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
  }

  console.log(`📦 Creating backup at: ${backupPath}`);

  ALL_FILES.forEach((filename) => {
    const sourcePath = path.join(IMAGES_DIR, filename);
    const backupFilePath = path.join(backupPath, filename);

    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, backupFilePath);
    }
  });

  console.log(`✓ Backup created successfully\n`);
  return backupPath;
}

/**
 * Optimize a single file
 */
async function optimizeFile(
  filename: string,
  quality: number,
  effort: number,
  tempDir: string
): Promise<OptimizationResult> {
  const inputPath = path.join(IMAGES_DIR, filename);
  const tempPath = path.join(tempDir, filename);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  const originalSize = fs.statSync(inputPath).size;

  // Compress with Sharp
  await sharp(inputPath)
    .avif({
      quality,
      effort,
      chromaSubsampling: '4:4:4',
      lossless: false,
    })
    .toFile(tempPath);

  const optimizedSize = fs.statSync(tempPath).size;

  // Check if file size increased (rare but possible)
  if (optimizedSize >= originalSize) {
    return {
      filename,
      originalSize,
      optimizedSize,
      reduction: '0%',
      skipped: true,
      skipReason: 'Optimized file is larger than original',
    };
  }

  // Verify the optimized file is valid
  try {
    const metadata = await sharp(tempPath).metadata();
    if (!metadata.format || metadata.format !== 'avif') {
      throw new Error('Invalid AVIF file');
    }
  } catch (error) {
    return {
      filename,
      originalSize,
      optimizedSize,
      reduction: '0%',
      skipped: true,
      skipReason: `Validation failed: ${error}`,
    };
  }

  const reduction = (((originalSize - optimizedSize) / originalSize) * 100).toFixed(1);

  return {
    filename,
    originalSize,
    optimizedSize,
    reduction: `${reduction}%`,
    skipped: false,
  };
}

/**
 * Apply optimizations to all files
 */
async function applyOptimizations(quality: number, effort: number, dryRun: boolean): Promise<void> {
  console.log('\n🎨 Starting AVIF Optimization Application\n');
  console.log(`Quality: ${quality}`);
  console.log(`Effort: ${effort}`);
  console.log(`Dry Run: ${dryRun ? 'Yes (no changes will be made)' : 'No'}\n`);

  // Validate parameters
  validateParams(quality, effort);

  // Create temporary directory
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // Create backup (unless dry run)
  let backupPath = '';
  if (!dryRun) {
    backupPath = createBackup();
  }

  // Process all files
  const results: OptimizationResult[] = [];
  let processedCount = 0;
  let skippedCount = 0;
  let totalOriginalSize = 0;
  let totalOptimizedSize = 0;

  console.log('🔄 Processing files...\n');

  for (const filename of ALL_FILES) {
    try {
      console.log(`Processing ${filename}...`);
      const result = await optimizeFile(filename, quality, effort, TEMP_DIR);
      results.push(result);

      totalOriginalSize += result.originalSize;

      if (result.skipped) {
        skippedCount++;
        console.log(`⏭️  Skipped: ${result.skipReason}`);
        totalOptimizedSize += result.originalSize; // Keep original size
      } else {
        processedCount++;
        totalOptimizedSize += result.optimizedSize;
        console.log(`✓ Optimized: ${(result.originalSize / 1024).toFixed(0)} KB → ${(result.optimizedSize / 1024).toFixed(0)} KB (${result.reduction} reduction)`);

        // Replace original file (unless dry run)
        if (!dryRun) {
          const tempPath = path.join(TEMP_DIR, filename);
          const finalPath = path.join(IMAGES_DIR, filename);
          fs.copyFileSync(tempPath, finalPath);
        }
      }
    } catch (error) {
      console.error(`✗ Failed to optimize ${filename}:`, error);
      skippedCount++;
    }
  }

  // Clean up temp directory
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }

  // Display summary
  console.log('\n📊 Optimization Summary:\n');
  console.log(`✓ Optimized: ${processedCount} files`);
  console.log(`⏭️  Skipped: ${skippedCount} files`);
  console.log(`Original total size: ${(totalOriginalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Optimized total size: ${(totalOptimizedSize / 1024 / 1024).toFixed(2)} MB`);

  const totalReduction = (((totalOriginalSize - totalOptimizedSize) / totalOriginalSize) * 100).toFixed(1);
  const savingsMB = ((totalOriginalSize - totalOptimizedSize) / 1024 / 1024).toFixed(2);
  console.log(`Total reduction: ${totalReduction}% (${savingsMB} MB saved)\n`);

  if (dryRun) {
    console.log('🔍 DRY RUN COMPLETE - No files were modified\n');
    console.log('To apply these optimizations, run:');
    console.log(`   npm run optimize:apply -- --quality=${quality} --effort=${effort}\n`);
  } else {
    console.log(`✅ Optimization complete!\n`);
    console.log(`📦 Backup saved at: ${backupPath}\n`);
    console.log('Next steps:');
    console.log('1. Test locally:');
    console.log('   npm run dev');
    console.log('2. Verify landing animation looks good');
    console.log('3. Re-upload to Vercel Blob (only changed files will upload):');
    console.log('   npm run migrate:blob');
    console.log('4. If you need to rollback:');
    console.log(`   cp ${backupPath}/* ${IMAGES_DIR}/\n`);
  }

  // Detailed results
  console.log('📝 Detailed Results:\n');
  results.forEach((result) => {
    const origKB = (result.originalSize / 1024).toFixed(0);
    const optKB = (result.optimizedSize / 1024).toFixed(0);
    const status = result.skipped ? `⏭️  SKIPPED (${result.skipReason})` : `✓ ${result.reduction} reduction`;
    console.log(`${result.filename}: ${origKB} KB → ${optKB} KB - ${status}`);
  });

  console.log('');
}

/**
 * Rollback function
 */
function showRollbackHelp(): void {
  console.log('\n📋 Rollback Instructions:\n');
  console.log('If you need to restore original files:');
  console.log('1. Find your backup in the .backups/ directory');
  console.log('2. Copy files back:');
  console.log('   cp .backups/images-<timestamp>/* public/images/');
  console.log('3. Re-upload to Vercel Blob:');
  console.log('   npm run migrate:blob\n');
}

/**
 * Main function
 */
async function main(): Promise<void> {
  try {
    const args = parseArgs();

    // Show help if no args
    if (process.argv.length === 2) {
      console.log('\n📖 AVIF Optimization Application\n');
      console.log('Usage:');
      console.log('  npm run optimize:apply -- --quality=80 --effort=9\n');
      console.log('Options:');
      console.log('  --quality=<number>  AVIF quality (1-100, default: 80)');
      console.log('  --effort=<number>   Compression effort (0-9, default: 9)');
      console.log('  --dry-run          Preview changes without modifying files\n');
      console.log('Examples:');
      console.log('  npm run optimize:apply -- --quality=80 --effort=9');
      console.log('  npm run optimize:apply -- --quality=75 --effort=9 --dry-run\n');
      console.log('Recommended settings:');
      console.log('  Quality 85, Effort 9 - Near lossless (~13% reduction)');
      console.log('  Quality 80, Effort 9 - Excellent quality (~37% reduction) ✅');
      console.log('  Quality 75, Effort 9 - Very good quality (~50% reduction)\n');
      showRollbackHelp();
      process.exit(0);
    }

    await applyOptimizations(args.quality, args.effort, args.dryRun);
  } catch (error) {
    console.error('\n❌ Optimization failed:', error);
    showRollbackHelp();
    process.exit(1);
  }
}

// Execute
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Unexpected error:', error);
    process.exit(1);
  });
