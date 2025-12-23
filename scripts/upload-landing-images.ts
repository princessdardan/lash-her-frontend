/**
 * upload-landing-images.ts
 *
 * One-time migration script to upload landing page images to Vercel Blob Storage
 *
 * Features:
 * - Uploads 23 landing AVIF frames + 1 logo
 * - Generates immutable URLs with content-based hashing
 * - Creates JSON mapping file for code integration
 * - Retry logic for failed uploads
 * - Verification of all uploads
 * - Progress tracking
 */

import { config } from 'dotenv';
import { put } from '@vercel/blob';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Load environment variables from .env.local
config({ path: path.join(process.cwd(), '.env.local') });

// Configuration
const IMAGES_DIR = path.join(process.cwd(), 'public', 'images');
const OUTPUT_FILE = path.join(process.cwd(), 'src', 'config', 'blob-urls.json');
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Files to upload
const LANDING_FRAMES = Array.from({ length: 23 }, (_, i) => `landing-${i + 1}.avif`);
const LOGO_FILE = 'lash-her-gold.avif';
const ALL_FILES = [...LANDING_FRAMES, LOGO_FILE];

interface UploadResult {
  filename: string;
  url: string;
  pathname: string;
  contentType: string;
  size: number;
  hash: string;
  skipped: boolean;
}

interface BlobUrlMapping {
  landingFrames: string[];
  logo: string;
  fileHashes: Record<string, string>;
  uploadedAt: string;
  metadata: {
    totalFiles: number;
    totalSize: number;
    cdnUrl: string;
  };
}

/**
 * Calculate SHA-256 hash of a file
 */
function calculateFileHash(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

/**
 * Load existing blob URL mapping
 */
function loadExistingMapping(): BlobUrlMapping | null {
  try {
    if (fs.existsSync(OUTPUT_FILE)) {
      const content = fs.readFileSync(OUTPUT_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.warn('Could not load existing mapping:', error);
  }
  return null;
}

/**
 * Get existing URL for a filename from mapping
 */
function getExistingUrl(filename: string, mapping: BlobUrlMapping | null): string | null {
  if (!mapping) return null;

  if (filename === LOGO_FILE) {
    return mapping.logo;
  }

  const frameMatch = filename.match(/landing-(\d+)\.avif/);
  if (frameMatch) {
    const frameIndex = parseInt(frameMatch[1]) - 1;
    return mapping.landingFrames[frameIndex] || null;
  }

  return null;
}

/**
 * Upload a single file with retry logic
 */
async function uploadFileWithRetry(
  filename: string,
  existingMapping: BlobUrlMapping | null,
  retries = MAX_RETRIES
): Promise<UploadResult> {
  const filePath = path.join(IMAGES_DIR, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = fs.statSync(filePath).size;
  const currentHash = calculateFileHash(filePath);

  // Check if file hash matches existing
  const existingHash = existingMapping?.fileHashes?.[filename];
  const existingUrl = getExistingUrl(filename, existingMapping);

  if (existingHash === currentHash && existingUrl) {
    console.log(`⏭️  Checking ${filename} (hash matches)...`);

    // Verify URL still works
    const urlValid = await verifyUpload(existingUrl);

    if (urlValid) {
      console.log(`✓ Skipped ${filename} (unchanged, URL verified)`);
      return {
        filename,
        url: existingUrl,
        pathname: new URL(existingUrl).pathname,
        contentType: filename.endsWith('.avif') ? 'image/avif' : 'image/png',
        size: fileSize,
        hash: currentHash,
        skipped: true,
      };
    }

    console.log(`⚠️  URL invalid for ${filename}, re-uploading...`);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Uploading ${filename} (attempt ${attempt}/${retries})...`);

      const blob = await put(filename, fileBuffer, {
        access: 'public',
        addRandomSuffix: false, // Keep original filename for easier debugging
        contentType: filename.endsWith('.avif') ? 'image/avif' : 'image/png',
        cacheControlMaxAge: 31536000, // 1 year - immutable caching
        allowOverwrite: true, // Allow re-running the script
      });

      console.log(`✓ Uploaded ${filename}: ${blob.url}`);

      return {
        filename,
        url: blob.url,
        pathname: blob.pathname,
        contentType: blob.contentType || '',
        size: fileSize,
        hash: currentHash,
        skipped: false,
      };

    } catch (error) {
      console.error(`✗ Upload failed for ${filename} (attempt ${attempt}/${retries}):`, error);

      if (attempt === retries) {
        throw new Error(`Failed to upload ${filename} after ${retries} attempts: ${error}`);
      }

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }

  throw new Error(`Unexpected error uploading ${filename}`);
}

/**
 * Verify uploaded file is accessible
 */
async function verifyUpload(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch (error) {
    console.error(`Verification failed for ${url}:`, error);
    return false;
  }
}

/**
 * Main upload function
 */
async function uploadAllImages(): Promise<void> {
  console.log('\n🚀 Starting Vercel Blob migration for landing page images\n');
  console.log(`Total files to process: ${ALL_FILES.length}`);
  console.log(`Source directory: ${IMAGES_DIR}\n`);

  // Verify BLOB_READ_WRITE_TOKEN is set
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN environment variable is not set');
  }

  // Load existing mapping
  const existingMapping = loadExistingMapping();
  if (existingMapping) {
    console.log('📋 Found existing mapping, will skip unchanged files\n');
  }

  const results: UploadResult[] = [];
  const failed: string[] = [];
  let totalSize = 0;
  let uploadedCount = 0;
  let skippedCount = 0;

  // Upload all files
  for (const filename of ALL_FILES) {
    try {
      const result = await uploadFileWithRetry(filename, existingMapping);
      results.push(result);
      totalSize += result.size;

      if (result.skipped) {
        skippedCount++;
      } else {
        uploadedCount++;
      }
    } catch (error) {
      console.error(`Failed to upload ${filename}:`, error);
      failed.push(filename);
    }
  }

  console.log('\n📊 Upload Summary:');
  console.log(`✓ Uploaded: ${uploadedCount} files`);
  console.log(`⏭️  Skipped: ${skippedCount} files (unchanged)`);
  console.log(`✗ Failed: ${failed.length} files`);
  console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`💰 Advanced Operations Saved: ${skippedCount}\n`);

  if (failed.length > 0) {
    throw new Error(`Upload incomplete. Failed files: ${failed.join(', ')}`);
  }

  // Verify all uploads
  console.log('🔍 Verifying uploads...\n');
  const verificationResults = await Promise.all(
    results.map(async (result) => ({
      filename: result.filename,
      verified: await verifyUpload(result.url),
    }))
  );

  const verificationFailed = verificationResults.filter(r => !r.verified);
  if (verificationFailed.length > 0) {
    throw new Error(
      `Verification failed for: ${verificationFailed.map(r => r.filename).join(', ')}`
    );
  }

  console.log('✓ All uploads verified successfully\n');

  // Create URL mapping
  const landingFrameResults = results.filter(r => r.filename.startsWith('landing-'));
  const logoResult = results.find(r => r.filename === LOGO_FILE);

  if (!logoResult) {
    throw new Error('Logo file upload not found in results');
  }

  // Build file hashes map
  const fileHashes: Record<string, string> = {};
  results.forEach(r => {
    fileHashes[r.filename] = r.hash;
  });

  const mapping: BlobUrlMapping = {
    landingFrames: landingFrameResults
      .sort((a, b) => {
        const numA = parseInt(a.filename.match(/landing-(\d+)/)?.[1] || '0');
        const numB = parseInt(b.filename.match(/landing-(\d+)/)?.[1] || '0');
        return numA - numB;
      })
      .map(r => r.url),
    logo: logoResult.url,
    fileHashes,
    uploadedAt: new Date().toISOString(),
    metadata: {
      totalFiles: results.length,
      totalSize,
      cdnUrl: new URL(results[0].url).origin,
    },
  };

  // Write mapping to file
  const configDir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(mapping, null, 2));

  console.log(`✓ URL mapping saved to: ${OUTPUT_FILE}\n`);
  console.log('📝 Mapping preview:');
  console.log(`   Landing frames: ${mapping.landingFrames.length} URLs`);
  console.log(`   Logo: ${mapping.logo}`);
  console.log(`   CDN: ${mapping.metadata.cdnUrl}\n`);

  console.log('✅ Migration complete!\n');
  console.log('Next steps:');
  console.log('1. Update landing-animation.tsx to use blob URLs');
  console.log('2. Update next.config.ts to allow Vercel Blob domains');
  console.log('3. Test locally');
  console.log('4. Deploy to Vercel');
  console.log('5. Delete local images from /public/images/');
}

// Execute
uploadAllImages()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  });
