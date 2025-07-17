<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { voicesStore, refreshVoices } from '../lib/stores.js';
  
  export let chapter;
  export let mode;
  
  const dispatch = createEventDispatcher();
  const API_URL = 'http://localhost:8383';
  
  let loading = false;
  let error = null;
  let content = '';
  let originalContent = '';
  let speakers = [];
  let voices = [];
  let ttsInfo = null;
  let publishInfo = null;
  let publishSuccess = false;
  let scraping = false;
  let previewingVoices = new Set(); // Track which voices are being previewed
  let previewingSegments = new Set(); // Track which segments are being previewed
  let cachedSegments = [];
  let regeneratingSegments = new Set(); // Track which segments are being regenerated
  let rebuilding = false;
  let debugMerging = false;
  let mergeDebugOutput = '';
  let voicesPollInterval = null;
  let identifyingSpeakers = false;
  let speakerIdProgress = null;
  let speakerIdPollInterval = null;
  let streamingSegments = []; // Segments that are streaming in real-time
  
  $: if (mode === 'edit') loadChapterText();
  $: if (mode === 'speakers') loadSpeakers();
  $: if (mode === 'tts') loadTTSInfo();
  $: if (mode === 'publish') loadPublishInfo();
  
  // Subscribe to voices store for real-time updates
  voicesStore.subscribe(value => {
    voices = value;
  });
  
  // Start polling when component mounts
  onMount(() => {
    startVoicesPolling();
  });
  
  // Stop polling when component destroys
  onDestroy(() => {
    stopVoicesPolling();
    stopSpeakerIdPolling();
  });
  
  // Restart polling when mode changes
  $: if (mode) {
    stopVoicesPolling();
    startVoicesPolling();
  }
  
  async function loadChapterText() {
    loading = true;
    error = null;
    content = '';
    originalContent = '';
    
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/text`);
      if (!response.ok) {
        // Handle different response codes appropriately
        if (response.status === 404) {
          // This is a stub chapter - show scrape interface
          content = '';
          originalContent = '';
        } else {
          throw new Error(`Failed to load chapter text (${response.status})`);
        }
      } else {
        const data = await response.json();
        content = data.content || '';
        originalContent = data.content || '';
      }
    } catch (err) {
      // For network errors, assume it's a stub chapter
      console.log('Chapter text load error (treating as stub):', err.message);
      content = '';
      originalContent = '';
      error = null; // Clear error to show the scrape interface
    } finally {
      loading = false;
    }
  }

  async function scrapeChapterContent() {
    scraping = true;
    error = null;
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/scrape`, {
        method: 'POST'
      });
      if (!response.ok) throw new Error('Failed to scrape chapter content');
      
      // Start polling for content while scraping
      pollForContent();
      
    } catch (err) {
      error = err.message;
      scraping = false;
    }
  }

  async function pollForContent() {
    const maxAttempts = 30; // 30 attempts = 1 minute max
    let attempts = 0;
    
    const poll = async () => {
      attempts++;
      
      try {
        const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/text`);
        
        if (response.ok) {
          // Content is ready! Reload and stop polling
          await loadChapterText();
          dispatch('refresh'); // Refresh the chapters list
          scraping = false;
          return;
        }
        
        // Still not ready, continue polling if we haven't exceeded max attempts
        if (attempts < maxAttempts) {
          setTimeout(poll, 2000); // Poll every 2 seconds
        } else {
          // Timeout - stop polling and show error
          error = 'Scraping took too long. Please try refreshing.';
          scraping = false;
        }
        
      } catch (pollError) {
        // Continue polling on errors (network issues, etc.)
        if (attempts < maxAttempts) {
          setTimeout(poll, 2000);
        } else {
          error = 'Unable to check if scraping completed. Please refresh.';
          scraping = false;
        }
      }
    };
    
    // Start polling after a short delay
    setTimeout(poll, 2000);
  }
  
  async function saveChapterText() {
    loading = true;
    error = null;
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/text`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      if (!response.ok) throw new Error('Failed to save chapter');
      originalContent = content;
      close();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
  
  async function loadSpeakers() {
    loading = true;
    try {
      // Load segments, speakers, and voices in parallel
      const [segmentsResponse, speakersResponse, voicesData] = await Promise.all([
        fetch(`${API_URL}/api/chapters/${chapter.id}/segments`),
        fetch(`${API_URL}/api/speakers`),
        refreshVoices()
      ]);
      
      if (!segmentsResponse.ok) throw new Error('Failed to load chapter segments');
      if (!speakersResponse.ok) throw new Error('Failed to load speakers');
      
      const segmentsData = await segmentsResponse.json();
      const allSpeakers = await speakersResponse.json();
      voices = voicesData;
      
      // Extract segments array from response
      const segments = segmentsData.segments || [];
      
      // If no segments found and chapter has content, automatically start speaker identification
      if (segments.length === 0 && chapter.scrapedAt && !identifyingSpeakers) {
        // Auto-start speaker identification
        console.log('No speaker segments found, auto-starting speaker identification...');
        loading = false; // Reset loading state before starting speaker ID
        await identifySpeakers();
        return; // identifySpeakers will handle the rest
      }
      
      // Group segments by speaker
      const speakerMap = {};
      segments.forEach(segmentData => {
        const segment = segmentData.segment; // Extract the nested segment data
        const speakerName = segment.speaker_name;
        if (!speakerMap[speakerName]) {
          speakerMap[speakerName] = {
            name: speakerName,
            occurrences: 0,
            segments: [],
            voiceId: segment.voice_id,
            voiceName: segment.voice_name,
            isNarrator: segment.is_narrator,
            speakerId: segment.speaker_id
          };
        }
        speakerMap[speakerName].occurrences++;
        speakerMap[speakerName].segments.push({
          index: segment.segment_index,
          text: segment.text || '',
          fullText: segment.text || '',
          type: segment.type
        });
      });
      
      // Convert to array and add colors
      const colors = ['#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336', '#607D8B', '#795548', '#E91E63'];
      speakers = Object.values(speakerMap).map((speaker, index) => ({
        ...speaker,
        color: colors[index % colors.length]
      }));
      
      // Sort speakers: narrator first, then by occurrence count
      speakers.sort((a, b) => {
        if (a.isNarrator && !b.isNarrator) return -1;
        if (!a.isNarrator && b.isNarrator) return 1;
        return b.occurrences - a.occurrences;
      });
      
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
  
  async function loadTTSInfo() {
    loading = true;
    try {
      // Load cached segments information
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/segments`);
      if (response.ok) {
        const data = await response.json();
        cachedSegments = data.segments || [];
      } else {
        cachedSegments = [];
      }
      
      ttsInfo = {
        status: chapter.processedAt ? 'completed' : 'pending',
        voices: [],
        duration: chapter.duration,
        fileSize: chapter.fileSize,
        totalSegments: cachedSegments.length,
        cachedSegments: cachedSegments.filter(seg => seg.exists).length
      };
    } catch (err) {
      error = err.message;
      cachedSegments = [];
    } finally {
      loading = false;
    }
  }
  
  async function loadPublishInfo() {
    loading = true;
    try {
      // Check if chapter is ready for publishing - use the correct property names
      const canPublish = !!chapter.processedAt;
      
      publishInfo = {
        status: canPublish ? 'ready' : 'pending',
        feedUrl: `https://www.porivo.com/podcasts/feed.xml`,
        publishedAt: chapter.publishedAt,
        isPublished: !!chapter.publishedAt,
        canPublish: canPublish
      };
      
      // Load current feed info
      if (canPublish) {
        await loadFeedInfo();
      }
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
  
  async function loadFeedInfo() {
    try {
      const response = await fetch(`${API_URL}/api/feed/info`);
      if (response.ok) {
        const data = await response.json();
        publishInfo = {
          ...publishInfo,
          feedInfo: data
        };
      } else {
        // Don't fail the whole publish UI if feed info fails
        console.warn('Could not load feed info, continuing without it');
      }
    } catch (err) {
      console.warn('Failed to load feed info:', err);
      // Continue without feed info - not critical
    }
  }
  
  async function publishToFeed() {
    loading = true;
    error = null;
    try {
      // Generate RSS feed
      const feedResponse = await fetch(`${API_URL}/api/feed/generate`, {
        method: 'POST'
      });
      
      if (!feedResponse.ok) throw new Error('Failed to generate RSS feed');
      
      const feedResult = await feedResponse.json();
      
      // Sync to S3
      const syncResponse = await fetch(`${API_URL}/api/sync/s3`, {
        method: 'POST'
      });
      
      if (!syncResponse.ok) throw new Error('Failed to sync to S3');
      
      const syncResult = await syncResponse.json();
      
      // Update the chapter's published status
      chapter.publishedAt = new Date().toISOString();
      
      // Refresh chapter data in parent
      dispatch('refresh');
      
      // Reload publish info to show updated status
      await loadPublishInfo();
      
      // Show success message
      publishSuccess = true;
      setTimeout(() => {
        publishSuccess = false;
      }, 5000);
      
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
  
  async function assignVoice(speakerId, voiceId, voiceName) {
    try {
      const response = await fetch(`${API_URL}/api/speakers/${speakerId}/voice`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId, voiceName })
      });
      
      if (!response.ok) throw new Error('Failed to assign voice');
      
      // Update the local speakers data
      speakers = speakers.map(speaker => 
        speaker.speakerId === speakerId 
          ? { ...speaker, voiceId, voiceName }
          : speaker
      );
      
    } catch (err) {
      error = err.message;
    }
  }

  async function previewVoice(voiceId, speakerName) {
    const previewKey = `voice-${voiceId}`;
    if (previewingVoices.has(previewKey)) return;
    
    previewingVoices.add(previewKey);
    previewingVoices = previewingVoices; // Trigger reactivity
    
    try {
      const sampleText = `Hello, this is a voice preview for ${speakerName}. This is how this character will sound in the audiobook.`;
      
      const response = await fetch(`${API_URL}/api/voices/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId, text: sampleText })
      });
      
      if (!response.ok) throw new Error('Failed to generate preview');
      
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      
      // Clean up when audio ends
      audio.onended = () => {
        previewingVoices.delete(previewKey);
        previewingVoices = previewingVoices;
        URL.revokeObjectURL(audioUrl);
      };
      
      audio.onerror = () => {
        previewingVoices.delete(previewKey);
        previewingVoices = previewingVoices;
        URL.revokeObjectURL(audioUrl);
      };
      
      audio.play();
      
    } catch (err) {
      error = err.message;
      previewingVoices.delete(previewKey);
      previewingVoices = previewingVoices;
    }
  }

  async function previewSegment(voiceId, segmentText, speakerName, segmentIndex) {
    const previewKey = `segment-${voiceId}-${segmentIndex}`;
    if (previewingSegments.has(previewKey)) return;
    
    previewingSegments.add(previewKey);
    previewingSegments = previewingSegments; // Trigger reactivity
    
    try {
      const response = await fetch(`${API_URL}/api/voices/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId, text: segmentText })
      });
      
      if (!response.ok) throw new Error('Failed to generate segment preview');
      
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      
      // Clean up when audio ends
      audio.onended = () => {
        previewingSegments.delete(previewKey);
        previewingSegments = previewingSegments;
        URL.revokeObjectURL(audioUrl);
      };
      
      audio.onerror = () => {
        previewingSegments.delete(previewKey);
        previewingSegments = previewingSegments;
        URL.revokeObjectURL(audioUrl);
      };
      
      audio.play();
      
    } catch (err) {
      error = err.message;
      previewingSegments.delete(previewKey);
      previewingSegments = previewingSegments;
    }
  }

  async function identifySpeakers() {
    identifyingSpeakers = true;
    error = null;
    streamingSegments = []; // Reset streaming segments
    speakerIdProgress = {
      status: 'starting',
      phase: 'loading',
      message: 'Starting speaker identification...'
    };
    
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/identify-speakers`, {
        method: 'POST'
      });
      
      if (!response.ok) throw new Error('Failed to identify speakers');
      
      // Start polling for progress
      startSpeakerIdPolling();
      
    } catch (err) {
      error = err.message;
      identifyingSpeakers = false;
      speakerIdProgress = null;
      streamingSegments = [];
    }
  }
  
  async function pollSpeakerIdProgress() {
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/speaker-id-progress`);
      
      if (response.ok) {
        const progress = await response.json();
        speakerIdProgress = progress;
        
        // Check for new streaming segments
        if (progress.newSegment) {
          streamingSegments = [...streamingSegments, progress.newSegment];
          // Update segments with scrolling to show new ones
          streamingSegments = streamingSegments;
          
          // Auto-scroll to show new segments
          setTimeout(() => {
            const segmentsList = document.querySelector('.streaming-segments');
            if (segmentsList) {
              segmentsList.scrollTop = segmentsList.scrollHeight;
            }
          }, 100);
        }
        
        // Check if completed or failed
        if (progress.completed || progress.status === 'failed') {
          stopSpeakerIdPolling();
          
          if (progress.completed) {
            // Reload the speakers data
            await loadSpeakers();
            identifyingSpeakers = false;
            speakerIdProgress = null;
            streamingSegments = [];
          } else if (progress.status === 'failed') {
            error = progress.error || 'Speaker identification failed';
            identifyingSpeakers = false;
            streamingSegments = [];
          }
        }
      }
    } catch (err) {
      console.error('Failed to poll speaker ID progress:', err);
    }
  }
  
  function startSpeakerIdPolling() {
    if (speakerIdPollInterval) return;
    
    // Poll immediately
    pollSpeakerIdProgress();
    
    // Then poll every second
    speakerIdPollInterval = setInterval(pollSpeakerIdProgress, 1000);
  }
  
  function stopSpeakerIdPolling() {
    if (speakerIdPollInterval) {
      clearInterval(speakerIdPollInterval);
      speakerIdPollInterval = null;
    }
  }

  async function markSpeakerIdComplete() {
    loading = true;
    error = null;
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/mark-speakers-complete`, {
        method: 'POST'
      });
      
      if (!response.ok) throw new Error('Failed to mark speakers as complete');
      
      // Refresh the chapter data and close lightbox
      dispatch('refresh');
      close();
      
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  let fullChapterAudio = null;
  
  async function playFullChapter() {
    if (!fullChapterAudio) {
      const audioUrl = `${API_URL}/api/audio/${chapter.id}/${chapter.id}.mp3`;
      fullChapterAudio = new Audio(audioUrl);
      
      fullChapterAudio.addEventListener('error', (e) => {
        console.error('Full chapter audio playback error:', e);
        error = 'Failed to play full chapter audio';
      });
    }
    
    if (fullChapterAudio.paused) {
      try {
        await fullChapterAudio.play();
      } catch (err) {
        console.error('Failed to play full chapter:', err);
        error = 'Failed to play audio';
      }
    } else {
      fullChapterAudio.pause();
    }
  }

  // Store audio elements for segments
  let segmentAudios = {};
  
  async function playSegment(segmentIndex) {
    if (previewingSegments.has(segmentIndex)) {
      // Stop the audio
      const audio = segmentAudios[segmentIndex];
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      previewingSegments.delete(segmentIndex);
      previewingSegments = previewingSegments;
      return;
    }
    
    previewingSegments.add(segmentIndex);
    previewingSegments = previewingSegments;
    
    const audioUrl = `${API_URL}/api/audio/${chapter.id}/segment_${segmentIndex.toString().padStart(3, '0')}.mp3`;
    
    // Create audio element if it doesn't exist
    if (!segmentAudios[segmentIndex]) {
      const audio = new Audio(audioUrl);
      segmentAudios[segmentIndex] = audio;
      
      audio.addEventListener('ended', () => {
        previewingSegments.delete(segmentIndex);
        previewingSegments = previewingSegments;
      });
      
      audio.addEventListener('error', (e) => {
        console.error('Audio playback error:', e);
        previewingSegments.delete(segmentIndex);
        previewingSegments = previewingSegments;
      });
    }
    
    try {
      await segmentAudios[segmentIndex].play();
    } catch (err) {
      console.error('Failed to play audio:', err);
      previewingSegments.delete(segmentIndex);
      previewingSegments = previewingSegments;
    }
  }

  async function regenerateSegment(segmentIndex) {
    if (regeneratingSegments.has(segmentIndex)) return;
    
    regeneratingSegments.add(segmentIndex);
    regeneratingSegments = regeneratingSegments; // Trigger reactivity
    
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/segments/${segmentIndex}/regenerate`, {
        method: 'POST'
      });
      
      if (!response.ok) throw new Error('Failed to regenerate segment');
      
      // Reload cached segments
      await loadTTSInfo();
      
    } catch (err) {
      error = err.message;
    } finally {
      regeneratingSegments.delete(segmentIndex);
      regeneratingSegments = regeneratingSegments;
    }
  }

  async function rebuildChapter() {
    if (rebuilding) return;
    
    rebuilding = true;
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/rebuild`, {
        method: 'POST'
      });
      
      if (!response.ok) throw new Error('Failed to rebuild chapter');
      
      // Refresh the chapter data
      dispatch('refresh');
      await loadTTSInfo();
      
    } catch (err) {
      error = err.message;
    } finally {
      rebuilding = false;
    }
  }
  
  async function debugMergeChapter() {
    if (debugMerging) return;
    
    debugMerging = true;
    mergeDebugOutput = 'Starting debug merge...\n';
    
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/debug-merge`, {
        method: 'POST'
      });
      
      if (!response.ok) throw new Error('Failed to debug merge chapter');
      
      const result = await response.json();
      mergeDebugOutput = result.debugOutput || 'No debug output available';
      
    } catch (err) {
      error = err.message;
      mergeDebugOutput += `\nError: ${err.message}`;
    } finally {
      debugMerging = false;
    }
  }

  function startVoicesPolling() {
    if (mode === 'speakers') {
      // Poll every 3 seconds for voices when in speakers mode
      voicesPollInterval = setInterval(async () => {
        try {
          await refreshVoices();
        } catch (err) {
          console.error('Voices polling failed:', err);
        }
      }, 3000);
    }
  }
  
  function stopVoicesPolling() {
    if (voicesPollInterval) {
      clearInterval(voicesPollInterval);
      voicesPollInterval = null;
    }
  }
  
  function close() {
    stopVoicesPolling();
    dispatch('close');
  }
  
  function handleKeydown(event) {
    if (event.key === 'Escape') {
      close();
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
      minute: '2-digit'
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
  
  $: wordCount = content ? content.split(/\s+/).filter(w => w.length > 0).length : 0;
  $: charCount = content ? content.length : 0;
</script>

<style>
  .lightbox-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  
  .lightbox-content {
    background: white;
    border-radius: 8px;
    width: 90%;
    max-width: none;
    height: 90vh;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  
  .lightbox-header {
    padding: 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  .lightbox-title {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0;
  }
  
  .close-button {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #666;
    padding: 0.5rem;
    line-height: 1;
  }
  
  .close-button:hover {
    color: #333;
  }
  
  .lightbox-body {
    flex: 1;
    padding: 1.5rem;
    overflow-y: auto;
  }
  
  .lightbox-footer {
    padding: 1rem 1.5rem;
    border-top: 1px solid #e0e0e0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  
  /* Edit mode styles */
  .editor-container {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  
  .editor-stats {
    display: flex;
    gap: 2rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    color: #666;
  }
  
  .editor-textarea {
    flex: 1;
    width: 100%;
    padding: 1rem;
    font-family: 'Courier New', monospace;
    font-size: 1rem;
    line-height: 1.5;
    border: 1px solid #ddd;
    border-radius: 4px;
    resize: none;
    box-sizing: border-box;
  }
  
  .editor-actions {
    display: flex;
    gap: 1rem;
  }

  .no-content-state {
    text-align: center;
    padding: 3rem 2rem;
    background: #f9f9f9;
    border-radius: 8px;
    border: 2px dashed #ddd;
  }

  .no-content-state h3 {
    color: #666;
    margin-bottom: 1rem;
  }

  .no-content-state p {
    color: #777;
    margin-bottom: 1rem;
    line-height: 1.5;
  }

  .scrape-button {
    margin-top: 1rem;
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
  }
  
  /* Speaker mode styles */
  .speakers-list {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  
  .speaker-card {
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    overflow: hidden;
  }
  
  .speaker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    background: #f9f9f9;
    border-bottom: 1px solid #e0e0e0;
  }
  
  .speaker-info {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  
  .speaker-color {
    width: 24px;
    height: 24px;
    border-radius: 50%;
  }
  
  .speaker-name {
    font-weight: 500;
  }
  
  .speaker-count {
    font-size: 0.875rem;
    color: #666;
  }
  
  .speaker-sections {
    max-height: 200px;
    overflow-y: auto;
  }
  
  .section-item {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #f0f0f0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: #444;
  }
  
  .section-item:last-child {
    border-bottom: none;
  }
  
  .section-text {
    font-style: italic;
  }
  
  /* New speaker interface styles */
  .narrator-badge {
    background: #4CAF50;
    color: white;
    font-size: 0.7rem;
    padding: 0.2rem 0.5rem;
    border-radius: 12px;
    margin-left: 0.5rem;
    font-weight: 500;
  }
  
  .voice-assignment {
    color: #4CAF50;
    font-size: 0.875rem;
    margin-top: 0.25rem;
  }
  
  .no-voice {
    color: #999;
    font-size: 0.875rem;
    margin-top: 0.25rem;
  }
  
  .voice-controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  
  .voice-select {
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.875rem;
    min-width: 200px;
    flex: 1;
  }
  
  .preview-button {
    background: #2196F3;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    white-space: nowrap;
  }
  
  .preview-button:hover {
    background: #1976D2;
  }
  
  .speaker-segments {
    margin-top: 1rem;
  }
  
  .segments-header {
    font-weight: 600;
    margin-bottom: 0.5rem;
    color: #333;
    font-size: 0.875rem;
  }
  
  .segment-item {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #f0f0f0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: #444;
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .segment-preview-button {
    background: #2196F3;
    color: white;
    border: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.75rem;
    flex-shrink: 0;
    margin-left: auto;
  }

  .segment-preview-button:hover:not(:disabled) {
    background: #1976D2;
  }

  .segment-preview-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  
  .segment-type {
    padding: 0.2rem 0.5rem;
    border-radius: 12px;
    font-size: 0.7rem;
    font-weight: 500;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  
  .segment-type.narration {
    background: #e3f2fd;
    color: #1565c0;
  }
  
  .segment-type.dialogue {
    background: #f3e5f5;
    color: #7b1fa2;
  }
  
  .segment-type.thought {
    background: #fff3e0;
    color: #f57c00;
  }
  
  .segment-text {
    font-style: italic;
    flex: 1;
    white-space: pre-wrap;
    line-height: 1.4;
  }
  
  .more-segments {
    padding: 0.5rem 1rem;
    color: #666;
    font-size: 0.875rem;
    text-align: center;
    border-top: 1px solid #f0f0f0;
  }
  
  .loading-state {
    text-align: center;
    padding: 2rem;
    color: #666;
  }

  .speakers-header-actions {
    margin-bottom: 1.5rem;
    text-align: center;
  }
  
  /* TTS mode styles */
  .tts-container {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  
  .tts-info {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    height: 100%;
    overflow: hidden;
  }
  
  .tts-summary {
    background: #f9f9f9;
    padding: 1.5rem;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
  }
  
  .tts-summary h3 {
    margin: 0 0 1rem 0;
    color: #333;
  }
  
  .tts-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }
  
  .stat-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  
  .stat-label {
    font-size: 0.75rem;
    color: #666;
    font-weight: 500;
    text-transform: uppercase;
  }
  
  .stat-value {
    font-size: 1rem;
    font-weight: 600;
    color: #333;
  }
  
  .stat-value.completed {
    color: #4CAF50;
  }
  
  .stat-value.pending {
    color: #FF9800;
  }
  
  .tts-actions {
    display: flex;
    gap: 1rem;
    margin-top: 1rem;
  }
  
  .rebuild-button {
    background: #2196F3;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: background 0.2s;
  }
  
  .rebuild-button:hover:not(:disabled) {
    background: #1976D2;
  }
  
  .rebuild-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  
  .debug-button {
    background: #FF9800;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: background 0.2s;
  }
  
  .debug-button:hover:not(:disabled) {
    background: #F57C00;
  }
  
  .debug-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  
  .play-button {
    background: #9C27B0;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: background 0.2s;
  }
  
  .play-button:hover {
    background: #7B1FA2;
  }
  
  .tts-bottom-section {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    overflow: hidden;
  }
  
  .segments-cache {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  
  .segments-cache h3 {
    margin: 0 0 1rem 0;
    color: #333;
    flex-shrink: 0;
  }
  
  .segments-list {
    flex: 1;
    overflow-y: auto;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    background: white;
  }
  
  .segment-cache-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    border-bottom: 1px solid #f0f0f0;
    transition: background 0.2s;
  }
  
  .segment-cache-item:last-child {
    border-bottom: none;
  }
  
  .segment-cache-item:hover {
    background: #f9f9f9;
  }
  
  .segment-info {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex: 1;
    min-width: 0;
  }
  
  .segment-index {
    background: #f0f0f0;
    color: #666;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    min-width: 30px;
    text-align: center;
  }
  
  .segment-details {
    flex: 1;
    min-width: 0;
  }
  
  .segment-text {
    font-size: 0.875rem;
    color: #333;
    margin-bottom: 0.25rem;
    word-break: break-word;
    white-space: pre-wrap;
    line-height: 1.4;
  }
  
  .segment-meta {
    font-size: 0.75rem;
    color: #666;
    line-height: 1.3;
  }
  
  .segment-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  
  .segment-status {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    text-align: center;
  }
  
  .segment-status.cached {
    background: #e8f5e9;
    color: #2e7d32;
  }
  
  .segment-status.missing {
    background: #ffebee;
    color: #c62828;
  }
  
  .regenerate-button {
    background: #FF9800;
    color: white;
    border: none;
    padding: 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background 0.2s;
    min-width: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  
  .regenerate-button:hover:not(:disabled) {
    background: #F57C00;
  }
  
  .regenerate-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  
  .play-segment-button {
    background: #4CAF50;
    color: white;
    border: none;
    padding: 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background 0.2s;
    min-width: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-right: 0.5rem;
  }
  
  .play-segment-button:hover:not(:disabled) {
    background: #45a049;
  }
  
  .play-segment-button:disabled {
    background: #2196F3;
    cursor: pointer;
  }
  
  .tts-pending {
    padding: 2rem;
    text-align: center;
    color: #666;
  }
  
  /* Publish mode styles */
  .publish-container {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  
  .publish-pending {
    padding: 3rem;
    text-align: center;
    color: #666;
    background: #f9f9f9;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
  }
  
  .publish-pending p:first-child {
    font-size: 1.2rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }
  
  .publish-info {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    height: 100%;
  }
  
  .publish-success {
    background: #4CAF50;
    color: white;
    padding: 1rem;
    border-radius: 6px;
    text-align: center;
    font-weight: 500;
    animation: slideDown 0.3s ease-out;
  }
  
  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  
  .publish-summary {
    background: #f9f9f9;
    padding: 1.5rem;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
  }
  
  .publish-summary h3 {
    margin: 0 0 1rem 0;
    color: #333;
  }
  
  .publish-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }
  
  .stat-value.published {
    color: #4CAF50;
  }
  
  .stat-value.unpublished {
    color: #FF9800;
  }
  
  .publish-actions {
    display: flex;
    gap: 1rem;
    margin-top: 1rem;
  }
  
  .publish-button {
    background: #2196F3;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 500;
    transition: background 0.2s;
  }
  
  .publish-button:hover:not(:disabled) {
    background: #1976D2;
  }
  
  .publish-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  
  .feed-info {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  
  .feed-info h3 {
    margin: 0 0 1rem 0;
    color: #333;
  }
  
  .feed-info h4 {
    margin: 1.5rem 0 0.5rem 0;
    color: #555;
  }
  
  .feed-details {
    background: white;
    padding: 1rem;
    border-radius: 6px;
    border: 1px solid #e0e0e0;
    margin-bottom: 1rem;
  }
  
  .feed-item {
    padding: 0.5rem 0;
    border-bottom: 1px solid #f0f0f0;
  }
  
  .feed-item:last-child {
    border-bottom: none;
  }
  
  .feed-item strong {
    display: block;
    margin-bottom: 0.25rem;
    color: #666;
  }
  
  .feed-item a {
    color: #2196F3;
    text-decoration: none;
    word-break: break-all;
  }
  
  .feed-item a:hover {
    text-decoration: underline;
  }
  
  .subscribe-info {
    background: #e3f2fd;
    padding: 1.5rem;
    border-radius: 6px;
    border: 1px solid #90caf9;
  }
  
  .subscribe-info ol {
    margin: 0.5rem 0 0 1.5rem;
    padding: 0;
    line-height: 1.8;
  }
  
  .subscribe-info code {
    background: white;
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    font-family: monospace;
    font-size: 0.875rem;
    border: 1px solid #ddd;
  }
  
  /* Common styles */
  .error-message {
    background: #ffebee;
    color: #c62828;
    padding: 1rem;
    border-radius: 4px;
    margin-bottom: 1rem;
  }
  
  .loading-spinner {
    text-align: center;
    padding: 2rem;
    color: #666;
  }
  
  button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background 0.2s;
  }
  
  .primary-button {
    background: #4CAF50;
    color: white;
  }
  
  .primary-button:hover {
    background: #45a049;
  }
  
  .primary-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  
  .secondary-button {
    background: #f0f0f0;
    color: #333;
  }
  
  .secondary-button:hover {
    background: #e0e0e0;
  }
  
  .debug-output {
    background: #f5f5f5;
    padding: 1rem;
    border-radius: 6px;
    max-height: 300px;
    overflow-y: auto;
    flex-shrink: 0;
  }
  
  .debug-output h3 {
    margin: 0 0 0.5rem 0;
    color: #333;
  }
  
  .debug-output pre {
    margin: 0;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: 'Courier New', monospace;
    font-size: 0.875rem;
    line-height: 1.4;
    color: #333;
    background: white;
    padding: 1rem;
    border-radius: 4px;
    border: 1px solid #e0e0e0;
  }
  
  /* Speaker ID Progress styles */
  .speaker-id-progress {
    padding: 2rem;
    width: 90%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0; /* Allow flex item to shrink */
  }
  
  .speaker-id-progress h3 {
    text-align: center;
    margin-bottom: 2rem;
    color: #333;
  }
  
  .progress-phase {
    display: flex;
    justify-content: center;
    margin-bottom: 1.5rem;
  }
  
  .phase-indicator {
    background: #f0f0f0;
    padding: 0.75rem 1.5rem;
    border-radius: 24px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: all 0.3s ease;
  }
  
  .phase-indicator.loading {
    background: #e3f2fd;
    color: #1976D2;
  }
  
  .phase-indicator.loading_speakers {
    background: #f3e5f5;
    color: #7b1fa2;
  }
  
  .phase-indicator.analyzing {
    background: #fff3e0;
    color: #f57c00;
  }
  
  .phase-indicator.saving {
    background: #e8f5e9;
    color: #388e3c;
  }
  
  .phase-indicator.complete {
    background: #4CAF50;
    color: white;
  }
  
  .phase-indicator.error {
    background: #f44336;
    color: white;
  }
  
  .progress-message {
    text-align: center;
    color: #666;
    margin-bottom: 2rem;
    font-size: 1rem;
    line-height: 1.5;
  }
  
  .progress-stats {
    background: #f9f9f9;
    padding: 1rem;
    border-radius: 8px;
    margin-bottom: 1.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 2rem;
    justify-content: center;
  }
  
  .progress-stats .stat-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
  }
  
  .progress-stats .stat-label {
    font-size: 0.875rem;
    color: #666;
  }
  
  .progress-stats .stat-value {
    font-size: 1.25rem;
    font-weight: 600;
    color: #333;
  }
  
  .progress-results {
    margin-top: 2rem;
    padding: 1.5rem;
    background: #f0f7ff;
    border-radius: 8px;
    border: 1px solid #c3e0ff;
  }
  
  .progress-results h4 {
    margin: 0 0 1rem 0;
    color: #1976D2;
  }
  
  .speaker-breakdown {
    margin-top: 1.5rem;
  }
  
  .speaker-breakdown h5 {
    margin: 0 0 0.75rem 0;
    color: #666;
    font-size: 0.875rem;
    text-transform: uppercase;
  }
  
  .speaker-counts {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  
  .speaker-count-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 1rem;
    background: white;
    border-radius: 4px;
  }
  
  .speaker-count-item .speaker-name {
    font-weight: 500;
    color: #333;
  }
  
  .speaker-count-item .speaker-count {
    color: #666;
    font-size: 0.875rem;
  }
  
  .progress-loader {
    display: flex;
    justify-content: center;
    margin-top: 2rem;
  }
  
  .loader-spinner {
    width: 40px;
    height: 40px;
    border: 4px solid #f3f3f3;
    border-top: 4px solid #2196F3;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  /* Chunk progress styles */
  .chunk-progress {
    margin: 1.5rem 0;
    padding: 1rem;
    background: #f5f5f5;
    border-radius: 8px;
  }
  
  .progress-bar {
    width: 100%;
    height: 8px;
    background: #e0e0e0;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }
  
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #4CAF50, #45a049);
    transition: width 0.3s ease;
  }
  
  .progress-text {
    text-align: center;
    font-size: 0.875rem;
    color: #666;
    font-weight: 500;
  }
  
  /* Streaming segments styles */
  .streaming-segments {
    margin-top: 2rem;
    padding: 1.5rem;
    background: #f8f9fa;
    border-radius: 8px;
    border: 1px solid #e9ecef;
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    min-height: 0; /* Allow flex item to shrink */
  }
  
  .streaming-segments h4 {
    margin: 0 0 1rem 0;
    color: #333;
    font-size: 1rem;
  }
  
  .segments-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    flex: 1;
    overflow-y: auto;
  }
  
  .streaming-segment {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    padding: 0.75rem;
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.3s ease;
  }
  
  .streaming-segment.fade-in {
    opacity: 1;
    transform: translateY(0);
  }
  
  .segment-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  
  .segment-speaker {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .speaker-name {
    font-weight: 600;
    color: #333;
  }
  
  .segment-type {
    font-size: 0.75rem;
    color: #666;
    background: #f0f0f0;
    padding: 0.125rem 0.375rem;
    border-radius: 12px;
    text-transform: uppercase;
  }
  
  .segment-number {
    font-size: 0.75rem;
    color: #999;
    background: #f8f9fa;
    padding: 0.125rem 0.375rem;
    border-radius: 12px;
  }
  
  .segment-text {
    font-size: 0.875rem;
    color: #555;
    line-height: 1.4;
    word-wrap: break-word;
  }
</style>

<svelte:window on:keydown={handleKeydown} />

<div class="lightbox-backdrop" on:click={close}>
  <div class="lightbox-content" on:click|stopPropagation>
    <div class="lightbox-header">
      <h2 class="lightbox-title">
        {#if mode === 'edit'}
          Edit Chapter Text
        {:else if mode === 'speakers'}
          Speaker Identification
        {:else if mode === 'tts'}
          TTS Generation
        {:else if mode === 'publish'}
          Publishing Status
        {/if}
        - {chapter.title}
      </h2>
      <button class="close-button" on:click={close}>×</button>
    </div>
    
    <div class="lightbox-body">
      {#if loading}
        <div class="loading-spinner">Loading...</div>
      {:else if error}
        <div class="error-message">{error}</div>
      {:else if mode === 'edit'}
        <div class="editor-container">
          {#if !content && !scraping}
            <div class="no-content-state">
              <h3>No Content Available</h3>
              <p>This chapter is a stub record with title and URL, but no content has been scraped yet.</p>
              <p><strong>Chapter URL:</strong> <a href={chapter.url} target="_blank">{chapter.url}</a></p>
              <button 
                class="primary-button scrape-button" 
                on:click={scrapeChapterContent}
                disabled={scraping}
              >
                {#if scraping}
                  ⏳ Scraping Content... (auto-refreshing)
                {:else}
                  📖 Scrape Content from Patreon
                {/if}
              </button>
            </div>
          {:else}
            <div class="editor-stats">
              <span>Words: {wordCount.toLocaleString()}</span>
              <span>Characters: {charCount.toLocaleString()}</span>
            </div>
            <textarea 
              class="editor-textarea"
              bind:value={content}
              placeholder="Chapter content..."
            />
          {/if}
        </div>
      {:else if mode === 'speakers'}
        <div class="speakers-list">
          {#if loading}
            <div class="loading-state">
              <p>Loading speaker data...</p>
            </div>
          {:else if identifyingSpeakers && speakerIdProgress}
            <div class="speaker-id-progress">
              <h3>🎭 Speaker Identification Progress</h3>
              
              <div class="progress-phase">
                <div class="phase-indicator {speakerIdProgress.phase}">
                  {#if speakerIdProgress.phase === 'loading'}
                    📂 Loading Chapter
                  {:else if speakerIdProgress.phase === 'loading_speakers'}
                    👥 Loading Speakers
                  {:else if speakerIdProgress.phase === 'analyzing'}
                    🧠 Analyzing with GPT-4
                  {:else if speakerIdProgress.phase === 'saving'}
                    💾 Saving Results
                  {:else if speakerIdProgress.phase === 'complete'}
                    ✅ Complete
                  {:else if speakerIdProgress.phase === 'error'}
                    ❌ Error
                  {/if}
                </div>
              </div>
              
              <div class="progress-message">
                {speakerIdProgress.message || 'Processing...'}
              </div>
              
              {#if speakerIdProgress.totalChunks > 1}
                <div class="chunk-progress">
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: {((speakerIdProgress.currentChunk + 1) / speakerIdProgress.totalChunks) * 100}%"></div>
                  </div>
                  <div class="progress-text">
                    Chunk {speakerIdProgress.currentChunk + 1} of {speakerIdProgress.totalChunks}
                    {#if speakerIdProgress.chunkSegments}
                      - {speakerIdProgress.chunkSegments} segments processed
                    {/if}
                  </div>
                </div>
              {/if}
              
              {#if speakerIdProgress.contentLength}
                <div class="progress-stats">
                  <div class="stat-item">
                    <span class="stat-label">Content Size:</span>
                    <span class="stat-value">{speakerIdProgress.contentLength.toLocaleString()} characters</span>
                  </div>
                  {#if speakerIdProgress.knownSpeakers !== undefined}
                    <div class="stat-item">
                      <span class="stat-label">Known Speakers:</span>
                      <span class="stat-value">{speakerIdProgress.knownSpeakers}</span>
                    </div>
                  {/if}
                </div>
              {/if}
              
              {#if speakerIdProgress.segments}
                <div class="progress-results">
                  <h4>Results:</h4>
                  <div class="results-stats">
                    <div class="stat-item">
                      <span class="stat-label">Total Segments:</span>
                      <span class="stat-value">{speakerIdProgress.segments}</span>
                    </div>
                  </div>
                  
                  {#if speakerIdProgress.speakerCounts}
                    <div class="speaker-breakdown">
                      <h5>Speaker Breakdown:</h5>
                      <div class="speaker-counts">
                        {#each Object.entries(speakerIdProgress.speakerCounts) as [speaker, count]}
                          <div class="speaker-count-item">
                            <span class="speaker-name">{speaker}:</span>
                            <span class="speaker-count">{count} segments</span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>
              {/if}
              
              <div class="progress-loader">
                <div class="loader-spinner"></div>
              </div>
              
              {#if streamingSegments.length > 0}
                <div class="streaming-segments">
                  <h4>📝 Segments Identified:</h4>
                  <div class="segments-list">
                    {#each streamingSegments as segment, index}
                      <div class="streaming-segment" class:fade-in={true}>
                        <div class="segment-header">
                          <div class="segment-speaker">
                            <span class="speaker-name">{segment.speaker}</span>
                            <span class="segment-type">{segment.type}</span>
                          </div>
                          <div class="segment-number">#{index + 1}</div>
                        </div>
                        <div class="segment-text">
                          {segment.text.length > 150 ? segment.text.substring(0, 150) + '...' : segment.text}
                        </div>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          {:else if speakers.length === 0}
            {#if !chapter.scrapedAt}
              <div class="tts-status tts-pending">
                <p>No chapter content available. Please scrape the chapter content first.</p>
              </div>
            {:else}
              <div class="tts-status tts-pending">
                <p>Preparing to identify speakers...</p>
              </div>
            {/if}
          {:else}
            <div class="speakers-header-actions">
              <button class="primary-button" on:click={markSpeakerIdComplete}>
                ✅ Mark Speaker ID Complete
              </button>
            </div>
            {#each speakers as speaker}
              <div class="speaker-card">
                <div class="speaker-header">
                  <div class="speaker-info">
                    <div class="speaker-color" style="background: {speaker.color}"></div>
                    <div>
                      <div class="speaker-name">
                        {speaker.name}
                        {#if speaker.isNarrator}
                          <span class="narrator-badge">NARRATOR</span>
                        {/if}
                      </div>
                      <div class="speaker-count">{speaker.occurrences} segments</div>
                      {#if speaker.voiceName}
                        <div class="voice-assignment">
                          🎤 Voice: {speaker.voiceName}
                        </div>
                      {:else}
                        <div class="no-voice">No voice assigned</div>
                      {/if}
                    </div>
                  </div>
                  
                  <div class="voice-controls">
                    <select 
                      class="voice-select"
                      value={speaker.voiceId || ''}
                      on:change={(e) => {
                        const voiceId = e.target.value;
                        const selectedVoice = voices.find(v => v.id === voiceId);
                        if (voiceId && selectedVoice) {
                          assignVoice(speaker.speakerId, voiceId, selectedVoice.name);
                        }
                      }}
                    >
                      <option value="">Select Voice...</option>
                      
                      {#if voices.some(v => v.provider === 'elevenlabs')}
                        <optgroup label="ElevenLabs Voices">
                          {#each voices.filter(v => v.provider === 'elevenlabs') as voice}
                            <option value={voice.id}>{voice.name}</option>
                          {/each}
                        </optgroup>
                      {/if}
                      
                      {#if voices.some(v => v.provider === 'custom')}
                        <optgroup label="Custom Voices">
                          {#each voices.filter(v => v.provider === 'custom') as voice}
                            <option value={voice.id}>{voice.name}</option>
                          {/each}
                        </optgroup>
                      {/if}
                    </select>
                    
                    {#if speaker.voiceId}
                      <button 
                        class="preview-button"
                        on:click={() => previewVoice(speaker.voiceId, speaker.name)}
                        disabled={previewingVoices.has(`voice-${speaker.voiceId}`)}
                      >
                        {#if previewingVoices.has(`voice-${speaker.voiceId}`)}
                          ⏳ Generating...
                        {:else}
                          🎧 Preview
                        {/if}
                      </button>
                    {/if}
                  </div>
                </div>
                
                <div class="speaker-segments">
                  <div class="segments-header">Sample segments:</div>
                  {#each speaker.segments.slice(0, 3) as segment, segmentIndex}
                    <div class="segment-item">
                      <div class="segment-type {segment.type}">{segment.type}</div>
                      <div class="segment-text">"{segment.text}"</div>
                      <button 
                        class="segment-preview-button"
                        on:click={() => previewSegment(speaker.voiceId, segment.fullText, speaker.name, segment.index)}
                        disabled={!speaker.voiceId || previewingSegments.has(`segment-${speaker.voiceId}-${segment.index}`)}
                        title={speaker.voiceId ? 'Preview this segment with assigned voice' : 'Assign a voice first to preview'}
                      >
                        {#if previewingSegments.has(`segment-${speaker.voiceId}-${segment.index}`)}
                          ⏳
                        {:else}
                          🎧
                        {/if}
                      </button>
                    </div>
                  {/each}
                  {#if speaker.segments.length > 3}
                    <div class="more-segments">
                      ...and {speaker.segments.length - 3} more segments
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          {/if}
        </div>
      {:else if mode === 'tts'}
        <div class="tts-container">
          {#if ttsInfo?.status === 'pending' && cachedSegments.length === 0}
            <div class="tts-pending">
              <p>TTS has not been generated yet.</p>
              <p>Complete speaker identification first, then run Stage 3.</p>
            </div>
          {:else}
            <div class="tts-info">
              <div class="tts-summary">
                <h3>TTS Generation Status</h3>
                <div class="tts-stats">
                  <div class="stat-item">
                    <div class="stat-label">Status:</div>
                    <div class="stat-value {ttsInfo?.status}">
                      {#if ttsInfo?.status === 'completed'}
                        ✅ Complete
                      {:else if ttsInfo?.status === 'pending'}
                        ⏳ Pending
                      {:else}
                        📋 Ready
                      {/if}
                    </div>
                  </div>
                  
                  {#if ttsInfo?.duration}
                    <div class="stat-item">
                      <div class="stat-label">Duration:</div>
                      <div class="stat-value">{Math.round(ttsInfo.duration)}s</div>
                    </div>
                  {/if}
                  
                  {#if ttsInfo?.fileSize}
                    <div class="stat-item">
                      <div class="stat-label">File Size:</div>
                      <div class="stat-value">{(ttsInfo.fileSize / 1024 / 1024).toFixed(1)}MB</div>
                    </div>
                  {/if}
                  
                  {#if ttsInfo?.totalSegments}
                    <div class="stat-item">
                      <div class="stat-label">Segments:</div>
                      <div class="stat-value">{ttsInfo.cachedSegments} / {ttsInfo.totalSegments} cached</div>
                    </div>
                  {/if}
                </div>
                
                <!-- DEBUG: Show cached segments length -->
                <div style="background: #f0f0f0; padding: 8px; margin: 8px 0; font-family: monospace; font-size: 12px;">
                  DEBUG: cachedSegments.length = {cachedSegments.length}
                  {#if cachedSegments.length > 0}
                    <br>First segment: {JSON.stringify(cachedSegments[0]?.segment?.text?.substring(0, 50) || 'undefined')}
                  {/if}
                </div>
                
                {#if cachedSegments.length > 0}
                  <div class="tts-actions">
                    <button 
                      class="rebuild-button"
                      on:click={() => rebuildChapter()}
                      disabled={rebuilding}
                    >
                      {#if rebuilding}
                        ⏳ Rebuilding...
                      {:else}
                        🔧 Rebuild Chapter
                      {/if}
                    </button>
                    
                    <button 
                      class="debug-button"
                      on:click={() => debugMergeChapter()}
                      disabled={debugMerging}
                    >
                      {#if debugMerging}
                        ⏳ Debugging...
                      {:else}
                        🐛 Debug Merge
                      {/if}
                    </button>
                    
                    {#if chapter.processedAt}
                      <button 
                        class="play-button"
                        on:click={() => playFullChapter()}
                        title="Play full chapter audio"
                      >
                        🎧 Play Full Chapter
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
              
              <div class="tts-bottom-section">
                {#if mergeDebugOutput}
                  <div class="debug-output">
                    <h3>Debug Output</h3>
                    <pre>{mergeDebugOutput}</pre>
                  </div>
                {/if}
                
                {#if cachedSegments.length > 0}
                  <div class="segments-cache">
                    <h3>Cached Segments</h3>
                    <div class="segments-list">
                      {#each cachedSegments as segmentFile, index}
                        <div class="segment-cache-item">
                          <div class="segment-info">
                            <div class="segment-index">#{index + 1}</div>
                            <div class="segment-details">
                              <div class="segment-text">
                                {segmentFile.segment.text}
                              </div>
                              <div class="segment-meta">
                                Speaker: {segmentFile.segment.speaker_name} • 
                                Type: {segmentFile.segment.type} • 
                                {#if segmentFile.exists}
                                  Size: {(segmentFile.size / 1024).toFixed(1)}KB
                                {:else}
                                  Not generated
                                {/if}
                              </div>
                            </div>
                          </div>
                          
                          <div class="segment-actions">
                            <div class="segment-status {segmentFile.exists ? 'cached' : 'missing'}">
                              {#if segmentFile.exists}
                                ✅ Cached
                              {:else}
                                ❌ Missing
                              {/if}
                            </div>
                            
                            {#if segmentFile.exists}
                              <button 
                                class="play-segment-button"
                                on:click={() => playSegment(index)}
                                disabled={previewingSegments.has(index)}
                                title="Play this segment"
                              >
                                {#if previewingSegments.has(index)}
                                  ⏸️
                                {:else}
                                  ▶️
                                {/if}
                              </button>
                            {/if}
                            
                            <button 
                              class="regenerate-button"
                              on:click={() => regenerateSegment(index)}
                              disabled={regeneratingSegments.has(index)}
                              title="Regenerate this segment"
                            >
                              {#if regeneratingSegments.has(index)}
                                ⏳
                              {:else}
                                🔄
                              {/if}
                            </button>
                          </div>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {:else if mode === 'publish'}
        <div class="publish-container">
          {#if publishInfo?.status === 'pending'}
            <div class="publish-pending">
              <p>🔒 This chapter cannot be published yet.</p>
              <p>Complete audio generation (Stage 3) before publishing.</p>
            </div>
          {:else}
            <div class="publish-info">
              {#if publishSuccess}
                <div class="publish-success">
                  ✅ Successfully published to podcast feed!
                </div>
              {/if}
              
              <div class="publish-summary">
                <h3>Publishing Status</h3>
                
                <div class="publish-stats">
                  <div class="stat-item">
                    <div class="stat-label">Status:</div>
                    <div class="stat-value {publishInfo?.isPublished ? 'published' : 'unpublished'}">
                      {#if publishInfo?.isPublished}
                        ✅ Published
                      {:else}
                        📝 Ready to Publish
                      {/if}
                    </div>
                  </div>
                  
                  {#if publishInfo?.publishedAt}
                    <div class="stat-item">
                      <div class="stat-label">Published:</div>
                      <div class="stat-value">{formatDate(publishInfo.publishedAt)}</div>
                    </div>
                  {/if}
                  
                  <div class="stat-item">
                    <div class="stat-label">Chapter Duration:</div>
                    <div class="stat-value">{formatDuration(chapter.duration)}</div>
                  </div>
                  
                  <div class="stat-item">
                    <div class="stat-label">File Size:</div>
                    <div class="stat-value">{chapter.fileSize ? (chapter.fileSize / 1024 / 1024).toFixed(1) + 'MB' : '-'}</div>
                  </div>
                </div>
                
                <div class="publish-actions">
                  {#if !publishInfo?.isPublished || true}
                    <button 
                      class="publish-button"
                      on:click={publishToFeed}
                      disabled={loading}
                    >
                      {#if loading}
                        ⏳ Publishing...
                      {:else}
                        📡 Publish to Podcast Feed
                      {/if}
                    </button>
                  {/if}
                </div>
              </div>
              
              <div class="feed-info">
                <h3>Podcast Feed Information</h3>
                
                <div class="feed-details">
                  <div class="feed-item">
                    <strong>RSS Feed URL:</strong>
                    <a href="https://www.porivo.com/podcasts/feed.xml" target="_blank">
                      https://www.porivo.com/podcasts/feed.xml
                    </a>
                  </div>
                  
                  <div class="feed-item">
                    <strong>Audio URL:</strong>
                    <a href="https://www.porivo.com/podcasts/audio/{chapter.id}.mp3" target="_blank">
                      https://www.porivo.com/podcasts/audio/{chapter.id}.mp3
                    </a>
                  </div>
                  
                  {#if publishInfo?.feedInfo}
                    <div class="feed-item">
                      <strong>Total Episodes in Feed:</strong>
                      {publishInfo.feedInfo.episodeCount || 0}
                    </div>
                  {/if}
                </div>
                
                <div class="subscribe-info">
                  <h4>Subscribe in Apple Podcasts:</h4>
                  <ol>
                    <li>Open Apple Podcasts on your iPhone</li>
                    <li>Tap "Library" at the bottom</li>
                    <li>Tap "Add a Show by URL..."</li>
                    <li>Paste: <code>https://www.porivo.com/podcasts/feed.xml</code></li>
                    <li>Tap "Subscribe"</li>
                  </ol>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
    
    {#if mode === 'edit' && !loading}
      <div class="lightbox-footer">
        <div class="editor-actions">
          <button 
            class="secondary-button" 
            on:click={() => content = originalContent}
            disabled={content === originalContent}
          >
            Reset
          </button>
        </div>
        <div class="editor-actions">
          <button class="secondary-button" on:click={close}>Cancel</button>
          <button 
            class="primary-button" 
            on:click={saveChapterText}
            disabled={content === originalContent}
          >
            Save Changes
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>