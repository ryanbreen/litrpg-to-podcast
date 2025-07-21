<script>
  import { onMount, onDestroy } from 'svelte';
  import ChapterLightbox from './ChapterLightbox.svelte';
  import GenerationProgressLightbox from './GenerationProgressLightbox.svelte';
  import { chaptersStore, refreshChapters } from '../lib/stores.js';

  let chapters = [];
  let loading = true;
  let error = null;
  let selectedChapter = null;
  let lightboxMode = null; // 'edit', 'speakers', 'tts', 'publish'
  let sortOrder = 'asc'; // 'asc' for oldest first (default), 'desc' for newest first
  // Testing prettier hook after Claude Code restart
  let loadingNext = false;
  let bulkExtractCount = 10; // Default number of chapters to extract
  let bulkExtracting = false;
  let bulkExtractProgress = null;
  let showGenerationProgress = false;
  let generatingChapter = null;
  let pollInterval = null;
  let chapterSpeakerInfo = {}; // Store speaker info for badges

  const API_URL = 'http://localhost:8383';

  async function loadChapters() {
    try {
      const data = await refreshChapters();
      chapters = data;
      sortChapters();
      loading = false;

      // Load speaker info for chapters with speaker ID completed
      await loadChapterSpeakerInfo();
    } catch (err) {
      error = err.message;
      loading = false;
    }
  }

  async function loadChapterSpeakerInfo() {
    // Only load speaker info for chapters with speaker ID stage completed
    const chaptersWithSpeakers = chapters.filter(
      (chapter) => getStageStatus(chapter, 'speakers') === 'completed'
    );

    console.log(
      `Loading speaker info for ${chaptersWithSpeakers.length} chapters`
    );

    for (const chapter of chaptersWithSpeakers) {
      try {
        // Fetch segments for this chapter
        const segmentsResponse = await fetch(
          `${API_URL}/api/chapters/${chapter.id}/segments`
        );

        if (segmentsResponse.ok) {
          const segmentsData = await segmentsResponse.json();
          const segments = segmentsData.segments || [];

          // Get unique speakers and check voice assignments from segments
          const speakerMap = new Map();
          segments.forEach((segmentData) => {
            const segment = segmentData.segment || segmentData;
            if (segment.speaker_name && segment.speaker_name !== 'Unknown') {
              if (!speakerMap.has(segment.speaker_name)) {
                speakerMap.set(segment.speaker_name, {
                  name: segment.speaker_name,
                  voice_id: segment.voice_id,
                });
              }
            }
          });

          // Find speakers without voice assignments
          const speakersWithoutVoice = [];
          speakerMap.forEach((speaker) => {
            if (!speaker.voice_id) {
              speakersWithoutVoice.push(speaker.name);
            }
          });

          chapterSpeakerInfo[chapter.id] = {
            totalSpeakers: speakerMap.size,
            unassignedCount: speakersWithoutVoice.length,
            unassignedSpeakers: speakersWithoutVoice,
          };

          console.log(
            `Chapter ${chapter.id}: ${speakersWithoutVoice.length} unassigned speakers`
          );
        }
      } catch (err) {
        console.error(
          `Failed to load speaker info for chapter ${chapter.id}:`,
          err
        );
      }
    }

    // Trigger reactivity
    chapterSpeakerInfo = chapterSpeakerInfo;
  }

  // Subscribe to chapters store for real-time updates
  chaptersStore.subscribe((value) => {
    chapters = value;
    sortChapters();
  });

  function sortChapters() {
    chapters = chapters.sort((a, b) => {
      // Extract chapter numbers from titles
      const chapterA = a.title.match(/Chapter\s+(\d+)/i);
      const chapterB = b.title.match(/Chapter\s+(\d+)/i);

      const numA = chapterA ? parseInt(chapterA[1]) : 0;
      const numB = chapterB ? parseInt(chapterB[1]) : 0;

      return sortOrder === 'asc' ? numA - numB : numB - numA;
    });
  }

  function toggleSort() {
    sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    sortChapters();
  }

  function openLightbox(chapter, mode) {
    selectedChapter = chapter;
    lightboxMode = mode;
  }

  async function closeLightbox() {
    selectedChapter = null;
    lightboxMode = null;
    await refreshChapters(); // Reload in case of changes
    await loadChapterSpeakerInfo(); // Reload speaker info
  }

  function getStageStatus(chapter, stage) {
    switch (stage) {
      case 'extract':
        return chapter.scrapedAt ? 'completed' : 'pending';
      case 'speakers':
        return chapter.speakersIdentifiedAt ? 'completed' : 'pending';
      case 'tts':
        return chapter.processedAt ? 'completed' : 'pending';
      case 'publish':
        return chapter.publishedAt ? 'completed' : 'pending';
      default:
        return 'pending';
    }
  }

  async function checkAllSpeakersHaveVoices(chapterId) {
    try {
      const response = await fetch(
        `${API_URL}/api/chapters/${chapterId}/segments`
      );
      if (!response.ok) return false;

      const data = await response.json();
      const segments = data.segments || [];

      // Check if all speakers have voices assigned
      for (const segmentData of segments) {
        const segment = segmentData.segment;
        if (!segment.voice_id) {
          return false;
        }
      }
      return true;
    } catch (error) {
      console.error('Error checking speaker voices:', error);
      return false;
    }
  }

  function canClickStage(chapter, stage) {
    switch (stage) {
      case 'extract':
        return true; // Can always click extract
      case 'speakers':
        return getStageStatus(chapter, 'extract') === 'completed';
      case 'tts':
        return getStageStatus(chapter, 'speakers') === 'completed';
      case 'publish':
        return getStageStatus(chapter, 'tts') === 'completed';
      default:
        return false;
    }
  }

  function getStageClickability(chapter, stage) {
    return canClickStage(chapter, stage) ? 'clickable' : 'disabled';
  }

  function getStageClass(status) {
    switch (status) {
      case 'completed':
        return 'stage-completed';
      case 'running':
        return 'stage-running';
      case 'error':
        return 'stage-error';
      default:
        return 'stage-pending';
    }
  }

  function formatDate(dateString) {
    if (!dateString) return 'Not started';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatDuration(seconds) {
    if (!seconds) return '-';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  async function loadNextChapter() {
    if (loadingNext) return;

    loadingNext = true;
    const initialChapterCount = chapters.length;

    try {
      const response = await fetch(`${API_URL}/api/chapters/load-next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!response.ok) throw new Error('Failed to load next chapter');

      const result = await response.json();

      // Poll more frequently until we see a new chapter
      const pollForNewChapter = async () => {
        const maxAttempts = 30; // 30 seconds max
        let attempts = 0;

        while (attempts < maxAttempts) {
          await refreshChapters();

          // Check if we have a new chapter
          if (chapters.length > initialChapterCount) {
            break;
          }

          // Wait 1 second before next check
          await new Promise((resolve) => setTimeout(resolve, 1000));
          attempts++;
        }
      };

      await pollForNewChapter();
    } catch (err) {
      error = err.message;
    } finally {
      loadingNext = false;
    }
  }

  async function bulkExtractChapters() {
    if (bulkExtracting || bulkExtractCount < 1) return;

    bulkExtracting = true;
    bulkExtractProgress = {
      total: bulkExtractCount,
      current: 0,
      succeeded: 0,
      failed: 0,
      chapters: [],
    };

    try {
      for (let i = 0; i < bulkExtractCount; i++) {
        bulkExtractProgress.current = i + 1;

        try {
          const response = await fetch(`${API_URL}/api/chapters/load-next`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ waitForCompletion: true }),
          });

          const result = await response.json();

          if (!response.ok || !result.success) {
            bulkExtractProgress.failed++;
            bulkExtractProgress.chapters.push({
              index: i + 1,
              status: 'failed',
              error: result.error || 'Failed to load chapter',
              chapterNumber: result.chapterNumber,
            });
            continue;
          }

          bulkExtractProgress.succeeded++;
          bulkExtractProgress.chapters.push({
            index: i + 1,
            status: 'success',
            chapterId: result.chapterId,
            chapterNumber: result.chapterNumber,
          });

          // Delay between requests to avoid browser conflicts and server overload
          if (i < bulkExtractCount - 1) {
            await new Promise((resolve) => setTimeout(resolve, 5000)); // 5 second delay
          }
        } catch (err) {
          bulkExtractProgress.failed++;
          bulkExtractProgress.chapters.push({
            index: i + 1,
            status: 'failed',
            error: err.message,
          });
        }
      }

      // Refresh chapters list after bulk extraction
      await loadChapters();
    } catch (err) {
      error = `Bulk extraction failed: ${err.message}`;
    } finally {
      bulkExtracting = false;
      // Keep progress visible for 5 seconds after completion
      setTimeout(() => {
        bulkExtractProgress = null;
      }, 5000);
    }
  }

  async function deleteChapter(chapterId) {
    if (!confirm(`Are you sure you want to delete chapter ${chapterId}?`)) {
      return;
    }

    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapterId}`, {
        method: 'DELETE',
      });

      if (!response.ok) throw new Error('Failed to delete chapter');

      await loadChapters(); // Reload to update the list
    } catch (err) {
      error = err.message;
    }
  }

  async function generateAudio(chapterId) {
    try {
      // Find the chapter and show progress lightbox
      generatingChapter = chapters.find((ch) => ch.id === chapterId);
      showGenerationProgress = true;

      const response = await fetch(
        `${API_URL}/api/chapters/${chapterId}/generate-audio`,
        {
          method: 'POST',
        }
      );

      if (!response.ok) throw new Error('Failed to start audio generation');

      // Update the chapter status locally to show it's processing
      chapters = chapters.map((ch) =>
        ch.id === chapterId ? { ...ch, status: 'processing' } : ch
      );
    } catch (err) {
      error = err.message;
      showGenerationProgress = false;
      generatingChapter = null;
    }
  }

  function closeGenerationProgress() {
    showGenerationProgress = false;
    generatingChapter = null;
    loadChapters(); // Refresh chapters when closing
  }

  function startPolling() {
    // Poll every 10 seconds to check for new chapters
    pollInterval = setInterval(async () => {
      try {
        await refreshChapters();
      } catch (err) {
        console.error('Polling failed:', err);
      }
    }, 10000);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  onMount(() => {
    loadChapters();
    startPolling();
  });

  onDestroy(() => {
    stopPolling();
  });
</script>

<div class="episodes-container">
  <div class="header">
    <h1>Chapters</h1>
    <button class="sort-button" on:click={toggleSort}>
      {sortOrder === 'asc' ? '↑' : '↓'}
      Sort: {sortOrder === 'asc' ? 'Oldest First' : 'Newest First'}
    </button>
  </div>

  {#if loading}
    <div class="loading">Loading chapters...</div>
  {:else if error}
    <div class="error-state">Error: {error}</div>
  {:else if chapters.length === 0}
    <div class="empty-state">
      <h2>No chapters found</h2>
      <p>Load chapters individually or in bulk to get started</p>

      <!-- Load Chapter Controls -->
      <div class="load-controls-container">
        <div class="load-controls">
          <!-- Single Chapter Load -->
          <div class="single-load">
            <button
              class="load-next-button"
              on:click={loadNextChapter}
              disabled={loadingNext || bulkExtracting}
            >
              {#if loadingNext}
                ⏳ Searching for next chapter...
              {:else}
                📖 Load Next Chapter
              {/if}
            </button>
          </div>

          <!-- Bulk Extract Controls -->
          <div class="bulk-controls">
            <div class="bulk-input-group">
              <label for="bulk-count-empty">Bulk Extract:</label>
              <input
                id="bulk-count-empty"
                type="number"
                bind:value={bulkExtractCount}
                min="1"
                max="50"
                disabled={bulkExtracting}
              />
              <button
                class="bulk-extract-button"
                on:click={bulkExtractChapters}
                disabled={bulkExtracting || loadingNext}
              >
                {#if bulkExtracting}
                  ⏳ Extracting {bulkExtractProgress?.current ||
                    0}/{bulkExtractProgress?.total || bulkExtractCount}...
                {:else}
                  📚 Extract Chapters
                {/if}
              </button>
            </div>
          </div>
        </div>

        <!-- Bulk Extract Progress -->
        {#if bulkExtractProgress}
          <div class="bulk-progress">
            <h4>Bulk Extraction Progress</h4>
            <div class="progress-stats">
              <span class="stat">
                📊 Progress: {bulkExtractProgress.current}/{bulkExtractProgress.total}
              </span>
              <span class="stat success">
                ✅ Succeeded: {bulkExtractProgress.succeeded}
              </span>
              <span class="stat error">
                ❌ Failed: {bulkExtractProgress.failed}
              </span>
            </div>
            {#if bulkExtractProgress.chapters.length > 0}
              <div class="progress-details">
                {#each bulkExtractProgress.chapters.slice(-5) as chapter}
                  <div class="progress-item {chapter.status}">
                    #{chapter.index}:
                    {#if chapter.status === 'success'}
                      ✅ Chapter {chapter.chapterNumber ||
                        chapter.chapterId ||
                        'loaded'}
                    {:else}
                      ❌ Chapter {chapter.chapterNumber || '?'}: {chapter.error ||
                        'Failed'}
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <div class="chapters-table">
      <table>
        <thead>
          <tr>
            <th>Chapter</th>
            <th>Processing Pipeline</th>
            <th>Audio</th>
            <th>Extracted</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each chapters as chapter}
            <tr>
              <td>
                <div class="chapter-title">{chapter.title}</div>
                <div class="chapter-id">ID: {chapter.id}</div>
              </td>
              <td>
                <div class="processing-stages">
                  <!-- Stage 1: Extract -->
                  <div
                    class="stage {getStageClass(
                      getStageStatus(chapter, 'extract')
                    )} {getStageClickability(chapter, 'extract')}"
                    on:click={() => {
                      if (canClickStage(chapter, 'extract')) {
                        openLightbox(chapter, 'edit');
                      }
                    }}
                  >
                    <div class="stage-icon">📝</div>
                    <div class="stage-name">Extract</div>
                    <div class="stage-status">
                      {getStageStatus(chapter, 'extract')}
                    </div>
                  </div>

                  <!-- Stage 2: Speaker ID -->
                  <div
                    class="stage {getStageClass(
                      getStageStatus(chapter, 'speakers')
                    )} {getStageClickability(
                      chapter,
                      'speakers'
                    )} {chapterSpeakerInfo[chapter.id]?.unassignedCount > 0
                      ? 'needs-action'
                      : ''}"
                    on:click={() => {
                      if (canClickStage(chapter, 'speakers')) {
                        openLightbox(chapter, 'speakers');
                      }
                    }}
                  >
                    <div class="stage-icon">🎭</div>
                    <div class="stage-name">
                      Speaker ID
                      {#if chapterSpeakerInfo[chapter.id]?.unassignedCount > 0}
                        <span class="speaker-badge"
                          >{chapterSpeakerInfo[chapter.id]
                            .unassignedCount}</span
                        >
                      {/if}
                    </div>
                    <div class="stage-status">
                      {getStageStatus(chapter, 'speakers')}
                    </div>
                  </div>

                  <!-- Stage 3: TTS -->
                  <div
                    class="stage {getStageClass(
                      getStageStatus(chapter, 'tts')
                    )} {getStageClickability(chapter, 'tts')}"
                    on:click={() => {
                      if (!canClickStage(chapter, 'tts')) return;

                      if (getStageStatus(chapter, 'tts') === 'completed') {
                        // If TTS is already completed, open lightbox to view/debug
                        openLightbox(chapter, 'tts');
                      } else if (
                        getStageStatus(chapter, 'speakers') === 'completed'
                      ) {
                        // If speakers completed but TTS not, generate audio
                        generateAudio(chapter.id);
                      } else {
                        // Otherwise open lightbox
                        openLightbox(chapter, 'tts');
                      }
                    }}
                    title={!canClickStage(chapter, 'tts')
                      ? 'Complete previous stages first'
                      : getStageStatus(chapter, 'tts') === 'completed'
                        ? 'View TTS details and debug tools'
                        : getStageStatus(chapter, 'speakers') === 'completed'
                          ? 'Click to generate audio'
                          : 'View TTS status'}
                  >
                    <div class="stage-icon">🎙️</div>
                    <div class="stage-name">Generate</div>
                    <div class="stage-status">
                      {getStageStatus(chapter, 'tts')}
                    </div>
                  </div>

                  <!-- Build MP3 (between stages) -->
                  <div
                    class="stage build-stage {chapter.processedAt
                      ? 'completed'
                      : getStageStatus(chapter, 'tts') === 'completed'
                        ? 'pending'
                        : 'locked'}"
                    on:click={() => {
                      if (getStageStatus(chapter, 'tts') === 'completed') {
                        openLightbox(chapter, 'build');
                      }
                    }}
                    title={getStageStatus(chapter, 'tts') !== 'completed'
                      ? 'Generate TTS first'
                      : 'Build MP3 from segments'}
                  >
                    <div class="stage-icon">🔨</div>
                    <div class="stage-name">Build</div>
                    <div class="stage-status">
                      {chapter.processedAt ? 'built' : 'needed'}
                    </div>
                  </div>

                  <!-- Stage 4: Publish -->
                  <div
                    class="stage {getStageClass(
                      getStageStatus(chapter, 'publish')
                    )} {getStageClickability(chapter, 'publish')}"
                    on:click={() => {
                      if (canClickStage(chapter, 'publish')) {
                        openLightbox(chapter, 'publish');
                      }
                    }}
                    title={!canClickStage(chapter, 'publish')
                      ? 'Complete previous stages first'
                      : 'View publish status'}
                  >
                    <div class="stage-icon">📡</div>
                    <div class="stage-name">Publish</div>
                    <div class="stage-status">
                      {getStageStatus(chapter, 'publish')}
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <div class="audio-info">
                  {#if chapter.duration}
                    {formatDuration(chapter.duration)}
                  {:else}
                    -
                  {/if}
                </div>
              </td>
              <td>
                <div class="audio-info">
                  {formatDate(chapter.scrapedAt)}
                </div>
              </td>
              <td>
                <button
                  class="delete-button"
                  on:click={() => deleteChapter(chapter.id)}
                  title="Delete Chapter"
                >
                  🗑️
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>

      <!-- Load Chapter Controls -->
      <div class="load-controls-container">
        <div class="load-controls">
          <!-- Single Chapter Load -->
          <div class="single-load">
            <button
              class="load-next-button"
              on:click={loadNextChapter}
              disabled={loadingNext || bulkExtracting}
            >
              {#if loadingNext}
                ⏳ Searching for next chapter...
              {:else}
                📖 Load Next Chapter
              {/if}
            </button>
          </div>

          <!-- Bulk Extract Controls -->
          <div class="bulk-controls">
            <div class="bulk-input-group">
              <label for="bulk-count">Bulk Extract:</label>
              <input
                id="bulk-count"
                type="number"
                bind:value={bulkExtractCount}
                min="1"
                max="50"
                disabled={bulkExtracting}
              />
              <button
                class="bulk-extract-button"
                on:click={bulkExtractChapters}
                disabled={bulkExtracting || loadingNext}
              >
                {#if bulkExtracting}
                  ⏳ Extracting {bulkExtractProgress?.current ||
                    0}/{bulkExtractProgress?.total || bulkExtractCount}...
                {:else}
                  📚 Extract Chapters
                {/if}
              </button>
            </div>
          </div>
        </div>

        <!-- Bulk Extract Progress -->
        {#if bulkExtractProgress}
          <div class="bulk-progress">
            <h4>Bulk Extraction Progress</h4>
            <div class="progress-stats">
              <span class="stat">
                📊 Progress: {bulkExtractProgress.current}/{bulkExtractProgress.total}
              </span>
              <span class="stat success">
                ✅ Succeeded: {bulkExtractProgress.succeeded}
              </span>
              <span class="stat error">
                ❌ Failed: {bulkExtractProgress.failed}
              </span>
            </div>
            {#if bulkExtractProgress.chapters.length > 0}
              <div class="progress-details">
                {#each bulkExtractProgress.chapters.slice(-5) as chapter}
                  <div class="progress-item {chapter.status}">
                    #{chapter.index}:
                    {#if chapter.status === 'success'}
                      ✅ Chapter {chapter.chapterNumber ||
                        chapter.chapterId ||
                        'loaded'}
                    {:else}
                      ❌ Chapter {chapter.chapterNumber || '?'}: {chapter.error ||
                        'Failed'}
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if selectedChapter && lightboxMode}
  <ChapterLightbox
    chapter={selectedChapter}
    mode={lightboxMode}
    on:close={closeLightbox}
    on:refresh={loadChapters}
  />
{/if}

{#if showGenerationProgress && generatingChapter}
  <GenerationProgressLightbox
    chapter={generatingChapter}
    on:close={closeGenerationProgress}
  />
{/if}

<style>
  /* Override narrow layout for episodes page */
  :global(main) {
    max-width: 95% !important;
    margin: 2rem auto !important;
  }

  .episodes-container {
    width: 100%;
    padding: 0 1rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  .sort-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: #f0f0f0;
    border: 1px solid #ddd;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .sort-button:hover {
    background: #e0e0e0;
  }

  .chapters-table {
    width: 100%;
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    overflow: hidden;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  thead {
    background: #f5f5f5;
    border-bottom: 2px solid #e0e0e0;
  }

  th {
    padding: 1rem;
    text-align: left;
    font-weight: 600;
    font-size: 0.875rem;
    color: #666;
  }

  tr {
    border-bottom: 1px solid #e0e0e0;
  }

  tr:hover {
    background: #f9f9f9;
  }

  td {
    padding: 1rem;
  }

  .chapter-title {
    font-weight: 500;
    color: #333;
  }

  .chapter-id {
    font-size: 0.75rem;
    color: #999;
  }

  .processing-stages {
    display: flex;
    gap: 0.5rem;
  }

  .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 100px;
    padding: 0.5rem;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
    border: 1px solid transparent;
  }

  .stage:hover {
    transform: translateY(-2px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .stage-icon {
    font-size: 1.5rem;
    margin-bottom: 0.25rem;
  }

  .stage-name {
    font-size: 0.75rem;
    font-weight: 500;
    text-align: center;
    position: relative;
  }

  .stage-status {
    font-size: 0.625rem;
    margin-top: 0.25rem;
  }

  .speaker-badge {
    display: inline-block;
    background: #ff6b6b;
    color: white;
    font-size: 0.7rem;
    font-weight: bold;
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    margin-left: 0.3rem;
    vertical-align: super;
    line-height: 1;
  }

  .stage-pending {
    background: #f5f5f5;
    color: #999;
  }

  .stage-completed {
    background: #e8f5e9;
    color: #2e7d32;
    border-color: #4caf50;
  }

  .stage-completed.needs-action {
    background: #fff3cd;
    color: #856404;
    border-color: #ffc107;
  }

  .stage-running {
    background: #e3f2fd;
    color: #1565c0;
    border-color: #2196f3;
  }

  .stage-error {
    background: #ffebee;
    color: #c62828;
    border-color: #f44336;
  }

  .stage-completed.stage:hover {
    background: #c8e6c9;
    transform: translateY(-4px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .stage.disabled {
    opacity: 0.5;
    cursor: not-allowed;
    background-color: #f5f5f5 !important;
    color: #ccc !important;
  }

  .stage.disabled:hover {
    background-color: #f5f5f5 !important;
    transform: none !important;
    box-shadow: none !important;
  }

  .build-stage {
    background: #fff3e0;
    color: #f57c00;
    border-color: #ff9800;
  }

  .build-stage.completed {
    background: #e8f5e9;
    color: #2e7d32;
    border-color: #4caf50;
  }

  .build-stage.locked {
    background: #f5f5f5;
    color: #999;
    opacity: 0.5;
    cursor: not-allowed;
  }

  .audio-info {
    font-size: 0.875rem;
    color: #666;
  }

  .empty-state {
    text-align: center;
    padding: 4rem 2rem;
    color: #666;
  }

  .error-state {
    background: #ffebee;
    color: #c62828;
    padding: 1rem;
    border-radius: 4px;
    margin: 2rem 0;
  }

  .loading {
    text-align: center;
    padding: 4rem;
    color: #666;
  }

  .delete-button {
    background: none;
    border: none;
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 4px;
    transition: background 0.2s;
  }

  .delete-button:hover {
    background: #ffebee;
  }

  .load-controls-container {
    padding: 2rem;
    border-top: 1px solid #e0e0e0;
    background: #f9f9f9;
  }

  .load-controls {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 3rem;
    flex-wrap: wrap;
  }

  .single-load {
    display: flex;
    align-items: center;
  }

  .bulk-controls {
    display: flex;
    align-items: center;
  }

  .bulk-input-group {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .bulk-input-group label {
    font-weight: 600;
    color: #333;
  }

  .bulk-input-group input[type='number'] {
    width: 80px;
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 1rem;
    text-align: center;
  }

  .bulk-extract-button {
    padding: 0.75rem 1.5rem;
    background: #2196f3;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s;
    white-space: nowrap;
  }

  .bulk-extract-button:hover:not(:disabled) {
    background: #1976d2;
  }

  .bulk-extract-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }

  .bulk-progress {
    margin-top: 2rem;
    padding: 1.5rem;
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
  }

  .bulk-progress h4 {
    margin: 0 0 1rem 0;
    color: #333;
  }

  .progress-stats {
    display: flex;
    gap: 2rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .stat {
    font-weight: 500;
  }

  .stat.success {
    color: #4caf50;
  }

  .stat.error {
    color: #f44336;
  }

  .progress-details {
    margin-top: 1rem;
    padding: 1rem;
    background: #f5f5f5;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.9rem;
  }

  .progress-item {
    padding: 0.25rem 0;
  }

  .progress-item.success {
    color: #2e7d32;
  }

  .progress-item.failed {
    color: #c62828;
  }

  .load-next-button {
    padding: 1rem 2rem;
    background: #4caf50;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.2s;
    min-width: 250px;
  }

  .load-next-button:hover:not(:disabled) {
    background: #45a049;
  }

  .load-next-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
</style>
