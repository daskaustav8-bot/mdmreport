const fs = require('fs');
const { uploadToGoogleDriveDirect } = require('../services/googleDriveService');
const { pool } = require('../db/supabase');
require('dotenv').config();

async function runBenchmark() {
  console.log('--- Starting Diagnostic Bottleneck Measurement ---');
  
  // 1. Simulate large uncompressed image buffer (8MB JPEG mockup)
  const largeSize = 8 * 1024 * 1024;
  const largeBuffer = Buffer.alloc(largeSize, 0xFF);
  largeBuffer[0] = 0xFF; largeBuffer[1] = 0xD8; largeBuffer[2] = 0xFF; // JPEG magic
  largeBuffer[largeSize - 2] = 0xFF; largeBuffer[largeSize - 1] = 0xD9;

  // 2. Simulate optimized image buffer (450KB JPEG mockup)
  const optSize = 450 * 1024;
  const optBuffer = Buffer.alloc(optSize, 0xFF);
  optBuffer[0] = 0xFF; optBuffer[1] = 0xD8; optBuffer[2] = 0xFF; // JPEG magic
  optBuffer[optSize - 2] = 0xFF; optBuffer[optSize - 1] = 0xD9;

  console.log('Large Image Size:', (largeSize / (1024 * 1024)).toFixed(2), 'MB');
  console.log('Optimized Image Size:', (optSize / 1024).toFixed(0), 'KB');

  // Benchmark Google Drive Upload with Optimized Buffer
  console.log('\n[Stage 3] Uploading Optimized Image (450 KB) to Google Drive...');
  const t0_drive = Date.now();
  let driveResult;
  try {
    driveResult = await uploadToGoogleDriveDirect({
      buffer: optBuffer,
      mimeType: 'image/jpeg',
      fileName: 'Benchmark_Optimized_Passbook.jpg',
      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
      description: 'Benchmark Test Upload (Optimized)'
    });
    const t1_drive = Date.now();
    console.log(`✓ Google Drive Upload (450 KB): ${t1_drive - t0_drive} ms | File ID: ${driveResult.fileId}`);
  } catch (err) {
    console.error('Drive upload failed:', err.message);
  }

  // Benchmark Supabase Database Query
  console.log('\n[Stage 4] Saving Metadata to Supabase PostgreSQL...');
  const t0_db = Date.now();
  if (driveResult && driveResult.fileId) {
    const trackerQuery = `
      INSERT INTO public.bank_passbook_submissions (
        school_id, school_name, drive_file_id, file_name, file_url, submission_status, submitted_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 'Submitted', NOW(), NOW()
      )
      ON CONFLICT (school_id) DO UPDATE SET
        submission_status = 'Submitted',
        updated_at = NOW();
    `;
    await pool.query(trackerQuery, ['19120500703', 'ABADPARA PRIMARY SCHOOL', driveResult.fileId, 'Benchmark_Optimized_Passbook.jpg', driveResult.viewUrl]);
  }
  const t1_db = Date.now();
  console.log(`✓ Supabase Database Save: ${t1_db - t0_db} ms`);

  // Compare with 8MB upload over network (calculated based on typical 10-20 Mbps mobile upload)
  console.log('\n--- Bottleneck Analysis Summary ---');
  console.log('Uploading 8MB uncompressed mobile photo on typical 4G connection (10 Mbps): ~6,400 - 8,000 ms');
  console.log('Uploading 450KB optimized photo on same connection: ~350 - 450 ms (~94% bandwidth reduction!)');

  await pool.end();
}

runBenchmark().catch(err => {
  console.error(err);
  process.exit(1);
});
