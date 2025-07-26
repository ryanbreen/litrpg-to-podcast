#!/usr/bin/env node

/**
 * Run speaker identification for a specific chapter
 * Usage: node scripts/run-speaker-id.js <chapter_id>
 * Example: node scripts/run-speaker-id.js rr_1005
 */

const chapterId = process.argv[2];

if (!chapterId) {
  console.error('❌ Please provide a chapter ID');
  console.error('Usage: node scripts/run-speaker-id.js <chapter_id>');
  console.error('Example: node scripts/run-speaker-id.js rr_1005');
  process.exit(1);
}

const API_URL = 'http://localhost:8383';

async function runSpeakerIdentification(chapterId) {
  console.log(`🎭 Starting speaker identification for chapter ${chapterId}...`);

  try {
    // Start speaker identification
    const startResponse = await fetch(
      `${API_URL}/api/chapters/${chapterId}/identify-speakers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (!startResponse.ok) {
      const error = await startResponse.text();
      throw new Error(`Failed to start: ${error}`);
    }

    const startResult = await startResponse.json();
    console.log('✅', startResult.message);

    // Monitor progress
    let isComplete = false;
    let lastStatus = '';

    while (!isComplete) {
      await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds

      const progressResponse = await fetch(
        `${API_URL}/api/chapters/${chapterId}/speaker-id-progress`
      );
      if (!progressResponse.ok) continue;

      const progress = await progressResponse.json();

      // Show progress updates
      const status = `${progress.phase || 'waiting'}: ${progress.message || '...'}`;
      if (status !== lastStatus) {
        console.log(`📊 ${status}`);
        lastStatus = status;
      }

      // Show chunk progress if available
      if (progress.currentChunk && progress.totalChunks) {
        console.log(
          `   Chunk ${progress.currentChunk}/${progress.totalChunks}`
        );
      }

      // Check if complete or failed
      if (progress.completed) {
        isComplete = true;
        console.log(`✅ Speaker identification completed!`);

        if (progress.speakerCounts) {
          console.log(`\n📊 Results:`);
          console.log(`   Total segments: ${progress.segments || 0}`);
          console.log(`   Speakers found:`);
          for (const [speaker, count] of Object.entries(
            progress.speakerCounts
          )) {
            console.log(`     - ${speaker}: ${count} segments`);
          }
        }
      } else if (progress.error) {
        isComplete = true;
        console.error(`❌ Failed: ${progress.error}`);
        process.exit(1);
      }
    }

    // Final validation - check for piracy warnings
    console.log(`\n🔍 Validating content...`);
    const segmentsResponse = await fetch(
      `${API_URL}/api/chapters/${chapterId}/segments`
    );
    if (segmentsResponse.ok) {
      const data = await segmentsResponse.json();
      const segments = data.segments || [];

      const warningFound = segments.some(
        (s) => s.text && s.text.includes('This tale has been unlawfully')
      );

      if (warningFound) {
        console.warn(
          '⚠️  WARNING: Royal Road piracy warning found in segments!'
        );
      } else {
        console.log('✅ No piracy warnings found in content');
      }

      console.log(`\n📊 Final segment count: ${segments.length}`);
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

runSpeakerIdentification(chapterId);
