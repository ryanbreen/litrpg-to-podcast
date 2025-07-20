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
  let speakerViewMode = 'segments'; // 'segments' or 'speakers'
  let allSegments = []; // All segments in order for the new view
  let uniqueSpeakers = []; // Unique speakers list for dropdowns
  let buildInfo = null;
  let buildProgress = null;
  let buildLogs = [];
  let building = false;
  let buildPollInterval = null;
  let rebuildProgress = null;
  let rebuildPollInterval = null;
  
  $: if (mode === 'edit') loadChapterText();
  $: if (mode === 'speakers') loadSpeakers();
  $: if (mode === 'tts') loadTTSInfo();
  $: if (mode === 'build') loadBuildInfo();
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
    stopRebuildPolling();
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
      
      // Create allSegments for the new segment-based view
      allSegments = segments.map(segmentData => {
        const segment = segmentData.segment;
        return {
          index: segment.segment_index,
          text: segment.text || '',
          type: segment.type,
          speakerName: segment.speaker_name,
          speakerId: segment.speaker_id,
          voiceId: segment.voice_id,
          voiceName: segment.voice_name,
          isNarrator: segment.is_narrator,
          isUnmatched: !segment.speaker_name || segment.speaker_name === 'Unknown'
        };
      }).sort((a, b) => a.index - b.index);
      
      // Create unique speakers list for dropdowns
      const speakerSet = new Set();
      const speakerMap = {};
      
      segments.forEach(segmentData => {
        const segment = segmentData.segment;
        const speakerName = segment.speaker_name;
        
        if (speakerName && speakerName !== 'Unknown') {
          speakerSet.add(speakerName);
        }
        
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
      
      // Create uniqueSpeakers list for dropdowns
      uniqueSpeakers = Array.from(speakerSet).sort();
      
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
      
      // Auto-start speaker identification if no segments exist
      if (segments.length === 0 && chapter.scrapedAt && !identifyingSpeakers) {
        console.log('No segments found, auto-starting speaker identification...');
        await identifySpeakers();
      }
      
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
  
  async function loadBuildInfo() {
    loading = true;
    try {
      // Check if MP3 exists
      const mp3Exists = await checkMp3Exists();
      
      // Load segment info
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/segments`);
      if (response.ok) {
        const data = await response.json();
        const segments = data.segments || [];
        
        buildInfo = {
          mp3Exists,
          totalSegments: segments.length,
          cachedSegments: segments.filter(seg => seg.exists).length,
          missingSegments: segments.filter(seg => !seg.exists).length,
          segments: segments,
          chapterProcessed: !!chapter.processedAt,
          audioFile: mp3Exists ? `${chapter.id}.mp3` : null,
          audioDuration: chapter.duration,
          audioFileSize: chapter.fileSize
        };
      }
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function checkMp3Exists() {
    try {
      const response = await fetch(`${API_URL}/api/audio/${chapter.id}/${chapter.id}.mp3`, {
        method: 'HEAD'
      });
      return response.ok;
    } catch {
      return false;
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
  
  async function updateSegmentSpeaker(segmentIndex, newSpeakerName) {
    try {
      // Find the new speaker's ID from the uniqueSpeakers list
      const newSpeaker = speakers.find(s => s.name === newSpeakerName);
      if (!newSpeaker) {
        console.error('Speaker not found:', newSpeakerName);
        return;
      }

      // Update the local segment data
      const segment = allSegments.find(s => s.index === segmentIndex);
      if (segment) {
        const oldSpeakerName = segment.speakerName;
        
        // Collect all segments that need updating (before changing anything)
        const segmentsToUpdate = allSegments.filter(seg => 
          seg.speakerName === oldSpeakerName
        );
        
        // Update all affected segments locally
        segmentsToUpdate.forEach(seg => {
          seg.speakerName = newSpeakerName;
          seg.speakerId = newSpeaker.speakerId;
          seg.isUnmatched = false;
        });
        
        // Trigger reactivity
        allSegments = [...allSegments];
        
        // Send updates to server for all affected segments
        const updatePromises = segmentsToUpdate.map(seg => 
          updateSegmentSpeakerOnServer(seg.index, newSpeaker.speakerId)
        );
        
        await Promise.all(updatePromises);
        console.log(`Updated speaker for ${segmentsToUpdate.length} segments from "${oldSpeakerName}" to "${newSpeakerName}"`);
      }
    } catch (err) {
      console.error('Failed to update segment speaker:', err);
    }
  }

  async function updateSegmentSpeakerOnServer(segmentIndex, newSpeakerId) {
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/segments/${segmentIndex}/speaker`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speakerId: newSpeakerId })
      });

      if (!response.ok) {
        throw new Error(`Failed to update segment speaker: ${response.statusText}`);
      }

      const result = await response.json();
      console.log('Server response:', result);
    } catch (err) {
      console.error('Failed to update segment speaker on server:', err);
      throw err;
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
  
  async function pollRebuildProgress() {
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/rebuild-progress`);
      
      if (response.ok) {
        const progress = await response.json();
        rebuildProgress = progress;
        
        // Update streaming segments if available
        if (progress.segments) {
          streamingSegments = progress.segments;
        }
        
        // Auto-scroll to show new content
        if (progress.ffmpegOutput && progress.ffmpegOutput.length > 0) {
          setTimeout(() => {
            const outputDiv = document.querySelector('.ffmpeg-output');
            if (outputDiv) {
              outputDiv.scrollTop = outputDiv.scrollHeight;
            }
          }, 100);
        }
        
        // Check if completed or failed
        if (progress.status === 'completed' || progress.status === 'failed') {
          stopRebuildPolling();
          
          if (progress.status === 'completed') {
            building = false;
            buildProgress = {
              status: 'completed',
              message: 'Rebuild completed successfully'
            };
            
            // Reload build info
            await loadBuildInfo();
          } else if (progress.status === 'failed') {
            building = false;
            buildProgress = {
              status: 'error',
              message: progress.error || 'Rebuild failed'
            };
            error = progress.error || 'Rebuild failed';
          }
        }
      }
    } catch (err) {
      console.error('Failed to poll rebuild progress:', err);
    }
  }
  
  function startRebuildPolling() {
    if (rebuildPollInterval) return;
    
    // Poll immediately
    pollRebuildProgress();
    
    // Then poll every 500ms for smoother updates
    rebuildPollInterval = setInterval(pollRebuildProgress, 500);
  }
  
  function stopRebuildPolling() {
    if (rebuildPollInterval) {
      clearInterval(rebuildPollInterval);
      rebuildPollInterval = null;
    }
  }
  
  async function startBuild(forceRebuild = false) {
    building = true;
    buildLogs = [];
    streamingSegments = [];
    rebuildProgress = null;
    buildProgress = {
      status: 'starting',
      message: forceRebuild ? 'Force rebuilding chapter MP3...' : 'Building chapter MP3...'
    };
    
    try {
      const endpoint = forceRebuild ? 
        `/api/chapters/${chapter.id}/rebuild` : 
        `/api/chapters/${chapter.id}/debug-merge`;
        
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      
      if (!response.ok) throw new Error('Failed to start build');
      
      // Start polling for progress if rebuilding
      if (forceRebuild) {
        startRebuildPolling();
      }
      
      const result = await response.json();
      
      if (result.debugOutput) {
        // Parse debug output into logs
        buildLogs = result.debugOutput.split('\n').filter(line => line.trim());
        buildProgress = {
          status: 'completed',
          message: 'Build completed successfully'
        };
      }
      
      // S3 sync is now handled automatically by the rebuild endpoint
      // No need to call syncToS3() separately
      
      // Reload build info
      await loadBuildInfo();
      
    } catch (err) {
      error = err.message;
      buildProgress = {
        status: 'error',
        message: err.message
      };
    } finally {
      building = false;
    }
  }
  
  async function syncToS3() {
    try {
      buildProgress = {
        status: 'syncing',
        message: 'Syncing to S3...'
      };
      
      const response = await fetch(`${API_URL}/api/sync/s3`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      
      if (!response.ok) throw new Error('Failed to sync to S3');
      
      buildProgress = {
        status: 'completed',
        message: 'Successfully synced to S3'
      };
      
    } catch (err) {
      buildProgress = {
        status: 'error',
        message: `S3 sync failed: ${err.message}`
      };
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
    // Append 'Z' to indicate UTC if not already present
    const utcString = dateString.includes('Z') || dateString.includes('+') ? dateString : dateString + 'Z';
    const date = new Date(utcString);
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

  /* New Segment View Styles */
  .view-toggle {
    display: flex;
    gap: 0.5rem;
    margin-right: 1rem;
  }

  .toggle-button {
    padding: 0.5rem 1rem;
    border: 1px solid #ddd;
    background: white;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .toggle-button:hover {
    background: #f5f5f5;
  }

  .toggle-button.active {
    background: #007bff;
    color: white;
    border-color: #007bff;
  }

  .speakers-header-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .segments-view {
    width: 100%;
  }

  .segments-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #eee;
  }

  .segments-header h4 {
    margin: 0;
    color: #333;
  }

  .unmatched-count {
    background: #ff6b6b;
    color: white;
    padding: 0.25rem 0.75rem;
    border-radius: 12px;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .segments-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .segment-row {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 1rem;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    background: white;
    transition: all 0.2s;
  }

  .segment-row:hover {
    border-color: #ccc;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }

  .segment-row.unmatched {
    border-color: #ff6b6b;
    background: #fff5f5;
  }

  .segment-index {
    font-weight: 600;
    color: #666;
    min-width: 3rem;
    text-align: center;
    background: #f8f9fa;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.875rem;
  }

  .segment-content {
    flex: 1;
    min-width: 0;
  }

  .segment-type-badge {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    margin-bottom: 0.5rem;
    text-transform: uppercase;
  }

  .segment-type-badge.dialogue {
    background: #e3f2fd;
    color: #1976d2;
  }

  .segment-type-badge.narration {
    background: #f3e5f5;
    color: #7b1fa2;
  }

  .segment-type-badge.thought {
    background: #fff3e0;
    color: #f57c00;
  }

  .speaker-assignment {
    min-width: 200px;
  }

  .speaker-select {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    background: white;
  }

  .assigned-speaker {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background: #f8f9fa;
    border-radius: 4px;
  }

  .assigned-speaker .speaker-name {
    font-weight: 500;
    color: #333;
  }

  .assigned-speaker .narrator-badge {
    background: #6c757d;
    color: white;
    padding: 0.125rem 0.375rem;
    border-radius: 10px;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .change-speaker-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 4px;
    opacity: 0.6;
    transition: opacity 0.2s;
  }

  .change-speaker-btn:hover {
    opacity: 1;
    background: #e9ecef;
  }
  
  /* Build Mode Styles */
  .build-container {
    width: 100%;
    padding: 1rem;
  }
  
  .build-info {
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }
  
  .build-summary {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1.5rem;
  }
  
  .build-summary h3 {
    margin-top: 0;
    margin-bottom: 1rem;
    color: #333;
  }
  
  .build-stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  
  .build-actions {
    display: flex;
    gap: 1rem;
    margin-top: 1.5rem;
  }
  
  .force-rebuild {
    background: #dc3545 !important;
    border-color: #dc3545 !important;
  }
  
  .force-rebuild:hover:not(:disabled) {
    background: #c82333 !important;
    border-color: #bd2130 !important;
  }
  
  .build-progress {
    background: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 8px;
    padding: 1.5rem;
  }
  
  .build-progress h4 {
    margin-top: 0;
    margin-bottom: 1rem;
    color: #495057;
  }
  
  .progress-status {
    padding: 0.75rem;
    border-radius: 4px;
    font-weight: 500;
  }
  
  .progress-status.starting {
    background: #cfe2ff;
    color: #004085;
  }
  
  .progress-status.syncing {
    background: #d1ecf1;
    color: #0c5460;
  }
  
  .progress-status.completed {
    background: #d4edda;
    color: #155724;
  }
  
  .progress-status.error {
    background: #f8d7da;
    color: #721c24;
  }
  
  .rebuild-progress {
    background: #f0f4f8;
    border: 1px solid #d1d9e6;
    border-radius: 8px;
    padding: 1.5rem;
    margin-top: 1rem;
  }
  
  .rebuild-progress h4 {
    margin-top: 0;
    margin-bottom: 1rem;
    color: #495057;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  
  .progress-phase {
    background: #e9ecef;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    margin-bottom: 0.75rem;
    font-size: 0.9rem;
  }
  
  .segment-counter {
    margin-left: 0.5rem;
    color: #6c757d;
  }
  
  .progress-message {
    padding: 0.5rem 0;
    color: #495057;
    font-style: italic;
  }
  
  .segment-analysis {
    margin-top: 1rem;
    background: white;
    border: 1px solid #dee2e6;
    border-radius: 4px;
    padding: 1rem;
  }
  
  .segment-analysis h5 {
    margin: 0 0 0.75rem 0;
    font-size: 0.95rem;
    color: #495057;
  }
  
  .segment-list {
    max-height: 400px;
    overflow-y: auto;
    font-size: 0.85rem;
    padding-right: 0.5rem;
  }
  
  .segment-info {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid #f0f0f0;
  }
  
  .segment-info:last-child {
    border-bottom: none;
  }
  
  .segment-index {
    font-weight: bold;
    color: #6c757d;
    min-width: 40px;
  }
  
  .segment-speaker {
    flex: 1;
    color: #495057;
  }
  
  .segment-duration {
    color: #28a745;
    font-family: monospace;
    min-width: 60px;
    text-align: right;
  }
  
  .segment-size {
    color: #17a2b8;
    font-family: monospace;
    min-width: 70px;
    text-align: right;
  }
  
  .ffmpeg-progress {
    margin-top: 1rem;
    background: #2d3748;
    border: 1px solid #1a202c;
    border-radius: 4px;
    padding: 1rem;
  }
  
  .ffmpeg-progress h5 {
    margin: 0 0 0.75rem 0;
    font-size: 0.95rem;
    color: #e2e8f0;
  }
  
  .ffmpeg-output {
    background: #1a202c;
    border-radius: 4px;
    padding: 0.75rem;
    max-height: 150px;
    overflow-y: auto;
    font-family: 'Courier New', monospace;
    font-size: 0.85rem;
    color: #a0aec0;
  }
  
  .ffmpeg-line {
    padding: 0.125rem 0;
    white-space: pre-wrap;
  }
  
  .rebuild-complete {
    margin-top: 1rem;
    padding: 0.75rem;
    background: #d4edda;
    border: 1px solid #c3e6cb;
    border-radius: 4px;
    color: #155724;
    font-weight: 500;
    text-align: center;
  }
  
  .build-logs {
    background: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 8px;
    padding: 1.5rem;
  }
  
  .build-logs h4 {
    margin-top: 0;
    margin-bottom: 1rem;
    color: #495057;
  }
  
  .log-container {
    background: white;
    border: 1px solid #dee2e6;
    border-radius: 4px;
    max-height: 400px;
    overflow-y: auto;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 0.875rem;
  }
  
  .log-line {
    display: flex;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid #f0f0f0;
    word-break: break-word;
  }
  
  .log-line:hover {
    background: #f8f9fa;
  }
  
  .log-line.highlight {
    background: #fff3cd;
    font-weight: 600;
  }
  
  .log-number {
    min-width: 3rem;
    color: #6c757d;
    margin-right: 1rem;
    user-select: none;
  }
  
  .log-text {
    flex: 1;
    white-space: pre-wrap;
  }
  
  .segment-list {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1.5rem;
  }
  
  .segment-list h4 {
    margin-top: 0;
    margin-bottom: 1rem;
    color: #333;
  }
  
  .segment-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.5rem;
    max-height: 200px;
    overflow-y: auto;
  }
  
  .segment-file {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0.5rem;
    background: #f8f9fa;
    border-radius: 4px;
    font-size: 0.75rem;
    font-family: monospace;
  }
  
  .segment-file.missing {
    background: #fff5f5;
    color: #dc3545;
  }
  
  .segment-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .segment-status {
    margin-left: 0.5rem;
  }
  
  .stat-value.exists {
    color: #28a745;
  }
  
  .stat-value.missing {
    color: #dc3545;
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
        {:else if mode === 'build'}
          MP3 Build & Debug
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
            <div class="tts-status tts-pending">
              <p>Speaker identification has not been run yet.</p>
              <button 
                class="primary-button" 
                on:click={identifySpeakers}
                disabled={identifyingSpeakers}
              >
                🎭 Identify Speakers
              </button>
            </div>
          {:else}
            <div class="speakers-header-actions">
              <div class="view-toggle">
                <button 
                  class="toggle-button"
                  class:active={speakerViewMode === 'segments'}
                  on:click={() => speakerViewMode = 'segments'}
                >
                  📋 Segments View
                </button>
                <button 
                  class="toggle-button"
                  class:active={speakerViewMode === 'speakers'}
                  on:click={() => speakerViewMode = 'speakers'}
                >
                  👥 Speakers View
                </button>
              </div>
              <button class="primary-button" on:click={markSpeakerIdComplete}>
                ✅ Mark Speaker ID Complete
              </button>
            </div>
            
            {#if speakerViewMode === 'segments'}
              <!-- New segment-based view -->
              <div class="segments-view">
                <div class="segments-header">
                  <h4>All Segments ({allSegments.length})</h4>
                  <div class="unmatched-count">
                    {allSegments.filter(s => s.isUnmatched).length} unmatched
                  </div>
                </div>
                
                <div class="segments-list">
                  {#each allSegments as segment}
                    <div class="segment-row" class:unmatched={segment.isUnmatched}>
                      <div class="segment-index">#{segment.index}</div>
                      
                      <div class="segment-content">
                        <div class="segment-type-badge {segment.type}">
                          {segment.type}
                        </div>
                        <div class="segment-text">
                          {segment.text.length > 200 ? segment.text.substring(0, 200) + '...' : segment.text}
                        </div>
                      </div>
                      
                      <div class="speaker-assignment">
                        {#if segment.isUnmatched}
                          <select 
                            class="speaker-select"
                            value=""
                            on:change={(e) => {
                              if (e.target.value) {
                                updateSegmentSpeaker(segment.index, e.target.value);
                              }
                            }}
                          >
                            <option value="">Select Speaker...</option>
                            {#each uniqueSpeakers as speakerName}
                              <option value={speakerName}>{speakerName}</option>
                            {/each}
                          </select>
                        {:else}
                          <div class="assigned-speaker">
                            <span class="speaker-name">{segment.speakerName}</span>
                            {#if segment.isNarrator}
                              <span class="narrator-badge">NARRATOR</span>
                            {/if}
                            <button 
                              class="change-speaker-btn"
                              on:click={() => {
                                // Make this segment unmatched so user can reassign
                                segment.isUnmatched = true;
                                segment.speakerName = 'Unknown';
                                allSegments = [...allSegments];
                              }}
                            >
                              ✏️
                            </button>
                          </div>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {:else}
              <!-- Original speakers view -->
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
      {:else if mode === 'build'}
        <div class="build-container">
          {#if loading}
            <div class="loading-state">
              <p>Loading build information...</p>
            </div>
          {:else if buildInfo}
            <div class="build-info">
              <div class="build-summary">
                <h3>MP3 Build Status</h3>
                
                <div class="build-stats">
                  <div class="stat-item">
                    <div class="stat-label">MP3 Status:</div>
                    <div class="stat-value {buildInfo.mp3Exists ? 'exists' : 'missing'}">
                      {#if buildInfo.mp3Exists}
                        ✅ Exists ({buildInfo.audioFile})
                      {:else}
                        ❌ Not Built
                      {/if}
                    </div>
                  </div>
                  
                  <div class="stat-item">
                    <div class="stat-label">Segments:</div>
                    <div class="stat-value">
                      {buildInfo.cachedSegments} / {buildInfo.totalSegments} cached
                    </div>
                  </div>
                  
                  {#if buildInfo.missingSegments > 0}
                    <div class="stat-item">
                      <div class="stat-label">Missing:</div>
                      <div class="stat-value error">{buildInfo.missingSegments} segments</div>
                    </div>
                  {/if}
                  
                  {#if buildInfo.audioDuration}
                    <div class="stat-item">
                      <div class="stat-label">Duration:</div>
                      <div class="stat-value">{Math.round(buildInfo.audioDuration)}s</div>
                    </div>
                  {/if}
                  
                  {#if buildInfo.audioFileSize}
                    <div class="stat-item">
                      <div class="stat-label">File Size:</div>
                      <div class="stat-value">{(buildInfo.audioFileSize / 1024 / 1024).toFixed(1)}MB</div>
                    </div>
                  {/if}
                </div>
                
                <div class="build-actions">
                  <button 
                    class="primary-button"
                    on:click={() => startBuild(false)}
                    disabled={building || buildInfo.cachedSegments === 0}
                  >
                    {#if building}
                      ⏳ Building...
                    {:else}
                      🔍 Debug Build (Dry Run)
                    {/if}
                  </button>
                  
                  <button 
                    class="primary-button force-rebuild"
                    on:click={() => startBuild(true)}
                    disabled={building || buildInfo.cachedSegments === 0}
                  >
                    {#if building}
                      ⏳ Building...
                    {:else}
                      🔨 Force Rebuild MP3
                    {/if}
                  </button>
                </div>
                
                {#if buildInfo.cachedSegments === 0}
                  <div class="warning-message">
                    ⚠️ No cached segments available. Generate TTS audio first.
                  </div>
                {/if}
              </div>
              
              {#if buildProgress}
                <div class="build-progress">
                  <h4>Build Progress</h4>
                  <div class="progress-status {buildProgress.status}">
                    {#if buildProgress.status === 'starting'}
                      🔄 {buildProgress.message}
                    {:else if buildProgress.status === 'syncing'}
                      ☁️ {buildProgress.message}
                    {:else if buildProgress.status === 'completed'}
                      ✅ {buildProgress.message}
                    {:else if buildProgress.status === 'error'}
                      ❌ {buildProgress.message}
                    {/if}
                  </div>
                </div>
              {/if}
              
              {#if rebuildProgress && rebuildProgress.status !== 'idle'}
                <div class="rebuild-progress">
                  <h4>🔍 Rebuild Debug Stream</h4>
                  
                  <div class="progress-phase">
                    <strong>Phase:</strong> {rebuildProgress.phase}
                    {#if rebuildProgress.currentSegment}
                      <span class="segment-counter">
                        ({rebuildProgress.currentSegment}/{rebuildProgress.totalSegments})
                      </span>
                    {/if}
                  </div>
                  
                  <div class="progress-message">
                    {rebuildProgress.message}
                  </div>
                  
                  {#if rebuildProgress.segments && rebuildProgress.segments.length > 0}
                    <div class="segment-analysis">
                      <h5>📊 Segment Analysis</h5>
                      <div class="segment-list">
                        {#each rebuildProgress.segments as segment}
                          <div class="segment-info">
                            <span class="segment-index">#{segment.index + 1}</span>
                            <span class="segment-speaker">{segment.speaker}</span>
                            <span class="segment-duration">{segment.duration.toFixed(2)}s</span>
                            <span class="segment-size">{(segment.size / 1024).toFixed(1)}KB</span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                  
                  {#if rebuildProgress.ffmpegOutput && rebuildProgress.ffmpegOutput.length > 0}
                    <div class="ffmpeg-progress">
                      <h5>🎬 FFmpeg Output</h5>
                      <div class="ffmpeg-output">
                        {#each rebuildProgress.ffmpegOutput as line}
                          <div class="ffmpeg-line">{line}</div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                  
                  {#if rebuildProgress.status === 'completed'}
                    <div class="rebuild-complete">
                      ✅ Total Duration: {rebuildProgress.totalDuration ? Math.round(rebuildProgress.totalDuration) + 's' : 'N/A'}
                      | File Size: {rebuildProgress.fileSize ? (rebuildProgress.fileSize / 1024 / 1024).toFixed(1) + 'MB' : 'N/A'}
                    </div>
                  {/if}
                </div>
              {/if}
              
              {#if buildLogs.length > 0}
                <div class="build-logs">
                  <h4>Build Debug Output</h4>
                  <div class="log-container">
                    {#each buildLogs as log, i}
                      <div class="log-line" class:highlight={log.includes('===') || log.includes('✅') || log.includes('❌')}>
                        <span class="log-number">{i + 1}</span>
                        <span class="log-text">{log}</span>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
              
              {#if buildInfo.segments.length > 0}
                <div class="segment-list">
                  <h4>Segment Files</h4>
                  <div class="segment-grid">
                    {#each buildInfo.segments as segment}
                      <div class="segment-file" class:missing={!segment.exists}>
                        <span class="segment-name">segment_{segment.index.toString().padStart(3, '0')}.mp3</span>
                        <span class="segment-status">
                          {#if segment.exists}
                            ✅
                          {:else}
                            ❌
                          {/if}
                        </span>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}
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