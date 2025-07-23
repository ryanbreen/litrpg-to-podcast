#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { Database } from '../src/shared/database.js';
import config from '../src/shared/config.js';

async function backfillMetadata() {
  const db = new Database();
  await db.init();

  try {
    console.log(
      '🔍 Starting metadata backfill for existing audio segments...\n'
    );

    // Get all chapters that have been processed
    const chapters = await db.all(`
      SELECT * FROM chapters 
      WHERE processed_at IS NOT NULL 
      ORDER BY id
    `);

    console.log(`Found ${chapters.length} processed chapters\n`);

    let totalSegments = 0;
    let metadataCreated = 0;
    let alreadyExists = 0;

    for (const chapter of chapters) {
      console.log(
        `\n📖 Processing chapter ${chapter.id} - ${chapter.title || 'Untitled'}`
      );

      const segments = await db.getChapterSegments(chapter.id);
      const segmentsDir = path.join(
        config.paths.output,
        'segments',
        chapter.id.toString()
      );

      console.log(`  Found ${segments.length} segments`);

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const segmentFile = path.join(
          segmentsDir,
          `segment_${i.toString().padStart(3, '0')}.mp3`
        );
        const segmentMetaFile = path.join(
          segmentsDir,
          `segment_${i.toString().padStart(3, '0')}.json`
        );

        totalSegments++;

        try {
          // Check if audio file exists
          await fs.access(segmentFile);

          // Check if metadata already exists
          try {
            await fs.access(segmentMetaFile);
            alreadyExists++;
          } catch {
            // Metadata doesn't exist, create it
            const metadata = {
              speaker_id: segment.speaker_id,
              speaker_name: segment.speaker_name,
              voice_id: segment.voice_id,
              voice_name: segment.voice_name || 'Unknown',
              text_hash: Buffer.from(segment.text).toString('base64'),
              generated_at: chapter.processed_at || new Date().toISOString(),
              backfilled: true,
              backfilled_at: new Date().toISOString(),
            };

            await fs.writeFile(
              segmentMetaFile,
              JSON.stringify(metadata, null, 2)
            );

            metadataCreated++;

            if (metadataCreated % 100 === 0) {
              console.log(
                `  ✅ Created ${metadataCreated} metadata files so far...`
              );
            }
          }
        } catch (error) {
          // Audio file doesn't exist, skip
          continue;
        }
      }
    }

    console.log('\n✨ Backfill complete!');
    console.log(`📊 Summary:`);
    console.log(`  - Total segments processed: ${totalSegments}`);
    console.log(`  - Metadata files created: ${metadataCreated}`);
    console.log(`  - Already had metadata: ${alreadyExists}`);
    console.log(
      `  - Segments without audio: ${totalSegments - metadataCreated - alreadyExists}`
    );
  } catch (error) {
    console.error('❌ Error during backfill:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Run the backfill
backfillMetadata().catch(console.error);
