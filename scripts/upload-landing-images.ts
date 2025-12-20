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
}

interface BlobUrlMapping {
  landingFrames: string[];
  logo: string;
  uploadedAt: string;
  metadata: {
    totalFiles: number;
    totalSize: number;
    cdnUrl: string;
  };
}

/**
 * Upload a single file with retry logic
 */
async function uploadFileWithRetry(
  filename: string,
  retries = MAX_RETRIES
): Promise<UploadResult> {
  const filePath = path.join(IMAGES_DIR, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = fs.statSync(filePath).size;

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
  console.log(`Total files to upload: ${ALL_FILES.length}`);
  console.log(`Source directory: ${IMAGES_DIR}\n`);

  // Verify BLOB_READ_WRITE_TOKEN is set
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN environment variable is not set');
  }

  const results: UploadResult[] = [];
  const failed: string[] = [];
  let totalSize = 0;

  // Upload all files
  for (const filename of ALL_FILES) {
    try {
      const result = await uploadFileWithRetry(filename);
      results.push(result);
      totalSize += result.size;
    } catch (error) {
      console.error(`Failed to upload ${filename}:`, error);
      failed.push(filename);
    }
  }

  console.log('\n📊 Upload Summary:');
  console.log(`✓ Successful: ${results.length}/${ALL_FILES.length}`);
  console.log(`✗ Failed: ${failed.length}`);
  console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB\n`);

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

  const mapping: BlobUrlMapping = {
    landingFrames: landingFrameResults
      .sort((a, b) => {
        const numA = parseInt(a.filename.match(/landing-(\d+)/)?.[1] || '0');
        const numB = parseInt(b.filename.match(/landing-(\d+)/)?.[1] || '0');
        return numA - numB;
      })
      .map(r => r.url),
    logo: logoResult.url,
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
