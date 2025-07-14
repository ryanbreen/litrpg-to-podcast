<script>
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  
  export let chapter;
  
  const dispatch = createEventDispatcher();
  const API_URL = 'http://localhost:8383';
  
  let progress = {
    status: 'starting',
    currentSegment: 0,
    totalSegments: 0,
    segments: [],
    error: null,
    completed: false
  };
  
  let progressInterval;
  let logSocket;
  let logs = [];
  let playingSegments = new Set();
  let regeneratingSegments = new Set();
  let segmentDetails = [];
  
  onMount(async () => {
    connectToLogs();
    
    // Check initial status - if already complete, load segments
    const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/generation-progress`);
    if (response.ok) {
      const initialProgress = await response.json();
      progress = initialProgress;
      
      if (progress.completed && (!progress.segments || progress.segments.length === 0)) {
        // Already complete, load the segments
        await loadCompletedSegments();
      }
    }
    
    startProgressPolling();
  });
  
  onDestroy(() => {
    if (progressInterval) clearInterval(progressInterval);
    if (logSocket) logSocket.close();
  });
  
  function connectToLogs() {
    try {
      logSocket = new WebSocket(`ws://localhost:8383/api/logs`);
      
      logSocket.onmessage = (event) => {
        const logEntry = JSON.parse(event.data);
        
        // Filter for generation-related logs
        if (logEntry.message.includes(chapter.id) || 
            logEntry.message.includes('TTS') || 
            logEntry.message.includes('generation') ||
            logEntry.message.includes('segment')) {
          logs = [...logs.slice(-19), logEntry]; // Keep last 20 logs
        }
      };
      
      logSocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    } catch (error) {
      console.error('Failed to connect to logs:', error);
    }
  }
  
  async function startProgressPolling() {
    // Load segment details first
    await loadSegmentDetails();
    
    progressInterval = setInterval(async () => {
      try {
        const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/generation-progress`);
        if (response.ok) {
          const newProgress = await response.json();
          progress = newProgress;
          
          // Stop polling if completed or failed
          if (progress.completed || progress.status === 'failed') {
            clearInterval(progressInterval);
            // Don't auto-close - let user interact with results
            
            // If completed but no segments in progress, load them from the API
            if (progress.completed && (!progress.segments || progress.segments.length === 0)) {
              await loadCompletedSegments();
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch progress:', error);
      }
    }, 1000); // Poll every second
  }
  
  async function loadSegmentDetails() {
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/segments`);
      if (response.ok) {
        const data = await response.json();
        // Map segment details from the segments array
        segmentDetails = data.segments?.map(seg => seg.segment) || [];
      }
    } catch (error) {
      console.error('Failed to load segment details:', error);
    }
  }
  
  async function loadCompletedSegments() {
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/segments`);
      if (response.ok) {
        const data = await response.json();
        // Create segment progress items from the loaded data
        if (data.segments && data.segments.length > 0) {
          progress.segments = data.segments.map(seg => ({
            text: seg.segment.text,
            status: seg.exists ? 'completed' : 'pending'
          }));
          progress.totalSegments = data.segments.length;
          segmentDetails = data.segments.map(seg => seg.segment);
        }
      }
    } catch (error) {
      console.error('Failed to load completed segments:', error);
    }
  }
  
  async function playSegment(index) {
    if (playingSegments.has(index)) return;
    
    playingSegments.add(index);
    playingSegments = playingSegments;
    
    try {
      // Use the API endpoint to serve audio files
      const audioUrl = `${API_URL}/api/audio/${chapter.id}/segment_${index.toString().padStart(3, '0')}.mp3`;
      const audio = new Audio(audioUrl);
      
      audio.onended = () => {
        playingSegments.delete(index);
        playingSegments = playingSegments;
      };
      
      audio.onerror = (e) => {
        console.error('Audio playback error:', e);
        playingSegments.delete(index);
        playingSegments = playingSegments;
      };
      
      await audio.play();
    } catch (error) {
      console.error('Failed to play segment:', error);
      playingSegments.delete(index);
      playingSegments = playingSegments;
    }
  }
  
  async function regenerateSegment(index) {
    if (regeneratingSegments.has(index)) return;
    
    regeneratingSegments.add(index);
    regeneratingSegments = regeneratingSegments;
    
    try {
      const response = await fetch(`${API_URL}/api/chapters/${chapter.id}/segments/${index}/regenerate`, {
        method: 'POST'
      });
      
      if (!response.ok) throw new Error('Failed to regenerate segment');
      
      // Reload segment details
      await loadSegmentDetails();
      
    } catch (error) {
      console.error('Failed to regenerate segment:', error);
    } finally {
      regeneratingSegments.delete(index);
      regeneratingSegments = regeneratingSegments;
    }
  }
  
  function close() {
    dispatch('close');
  }
  
  function handleKeydown(event) {
    if (event.key === 'Escape') {
      close();
    }
  }
  
  $: progressPercentage = progress.totalSegments > 0 ? 
    Math.round((progress.currentSegment / progress.totalSegments) * 100) : 0;
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
    max-width: none;  /* NEVER set max-width on lightboxes! */
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
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  
  .progress-section {
    background: #f9f9f9;
    padding: 1.5rem;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
  }
  
  .progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  
  .progress-status {
    font-size: 1.1rem;
    font-weight: 600;
  }
  
  .progress-status.starting {
    color: #FF9800;
  }
  
  .progress-status.generating {
    color: #2196F3;
  }
  
  .progress-status.completed {
    color: #4CAF50;
  }
  
  .progress-status.failed {
    color: #f44336;
  }
  
  .progress-percentage {
    font-size: 1.1rem;
    font-weight: 600;
    color: #2196F3;
  }
  
  .progress-bar {
    width: 100%;
    height: 20px;
    background: #e0e0e0;
    border-radius: 10px;
    overflow: hidden;
    margin-bottom: 1rem;
  }
  
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #4CAF50, #45a049);
    transition: width 0.3s ease;
    border-radius: 10px;
  }
  
  .progress-details {
    color: #666;
    font-size: 0.9rem;
    line-height: 1.4;
  }
  
  .segments-list {
    flex: 1;
    overflow-y: auto;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    margin-bottom: 1rem;
  }
  
  .segment-item {
    padding: 1rem;
    border-bottom: 1px solid #f0f0f0;
    display: flex;
    gap: 1rem;
    align-items: center;
  }
  
  .segment-item:last-child {
    border-bottom: none;
  }
  
  .segment-item.completed {
    background: #e8f5e9;
  }
  
  .segment-item.processing {
    background: #e3f2fd;
  }
  
  .segment-item.pending {
    background: #f5f5f5;
  }
  
  .segment-number {
    background: #f0f0f0;
    color: #666;
    padding: 0.5rem;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 600;
    min-width: 45px;
    text-align: center;
    flex-shrink: 0;
  }
  
  .segment-content {
    flex: 1;
    min-width: 0;
  }
  
  .segment-text {
    font-size: 0.875rem;
    color: #333;
    margin-bottom: 0.25rem;
    word-break: break-word;
  }
  
  .segment-meta {
    display: flex;
    gap: 1rem;
    font-size: 0.75rem;
    color: #666;
  }
  
  .segment-speaker {
    font-weight: 500;
  }
  
  .segment-voice {
    color: #2196F3;
  }
  
  .segment-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  
  .segment-status {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    border-radius: 12px;
    font-weight: 500;
    text-transform: uppercase;
  }
  
  .segment-status.completed {
    background: #4CAF50;
    color: white;
  }
  
  .segment-status.processing {
    background: #2196F3;
    color: white;
  }
  
  .segment-status.pending {
    background: #999;
    color: white;
  }
  
  .segment-button {
    background: #f0f0f0;
    border: none;
    padding: 0.5rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1rem;
    min-width: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }
  
  .play-button:hover:not(:disabled) {
    background: #4CAF50;
    transform: scale(1.1);
  }
  
  .regenerate-button:hover:not(:disabled) {
    background: #FF9800;
    transform: scale(1.1);
  }
  
  .segment-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .logs-section {
    background: #1e1e1e;
    color: #00ff00;
    padding: 1rem;
    border-radius: 4px;
    font-family: 'Courier New', monospace;
    font-size: 0.75rem;
    height: 200px;
    overflow-y: auto;
    flex-shrink: 0;
  }
  
  .log-entry {
    margin-bottom: 0.25rem;
    line-height: 1.2;
  }
  
  .log-timestamp {
    color: #888;
  }
  
  .log-message {
    margin-left: 0.5rem;
  }
  
  .completion-message {
    text-align: center;
    padding: 2rem;
    background: #e8f5e9;
    border-radius: 8px;
    color: #2e7d32;
  }
  
  .completion-message h3 {
    margin: 0 0 1rem 0;
    color: #4CAF50;
  }
</style>

<svelte:window on:keydown={handleKeydown} />

<div class="lightbox-backdrop" on:click={close}>
  <div class="lightbox-content" on:click|stopPropagation>
    <div class="lightbox-header">
      <h2 class="lightbox-title">
        🎙️ Generating Audio - {chapter.title}
      </h2>
      <button class="close-button" on:click={close}>×</button>
    </div>
    
    <div class="lightbox-body">
      <div class="progress-section">
        <div class="progress-header">
          <div class="progress-status {progress.status}">
            {#if progress.status === 'starting'}
              🔄 Starting Generation...
            {:else if progress.status === 'generating'}
              🎙️ Generating Audio...
            {:else if progress.status === 'completed'}
              ✅ Generation Complete!
            {:else if progress.status === 'failed'}
              ❌ Generation Failed
            {:else}
              📋 Preparing...
            {/if}
          </div>
          {#if progress.totalSegments > 0}
            <div class="progress-percentage">{progressPercentage}%</div>
          {/if}
        </div>
        
        {#if progress.totalSegments > 0}
          <div class="progress-bar">
            <div class="progress-fill" style="width: {progressPercentage}%"></div>
          </div>
          
          <div class="progress-details">
            Processing segment {progress.currentSegment} of {progress.totalSegments}
            {#if progress.currentSegment > 0}
              • {progress.currentSegment} completed
            {/if}
            {#if progress.totalSegments - progress.currentSegment > 0}
              • {progress.totalSegments - progress.currentSegment} remaining
            {/if}
          </div>
        {/if}
      </div>
      
      {#if progress.completed}
        <div class="completion-message">
          <h3>🎉 Audio Generation Complete!</h3>
          <p>Your chapter audio has been successfully generated. You can now:</p>
          <ul style="text-align: left; max-width: 600px; margin: 1rem auto;">
            <li>Play individual segments using the ▶️ buttons</li>
            <li>Regenerate any segment using the 🔄 buttons</li>
            <li>Review the generation logs below</li>
          </ul>
        </div>
      {/if}
      
      {#if progress.segments && progress.segments.length > 0}
        <div class="progress-section" style="display: flex; flex-direction: column; flex: 1; min-height: 0;">
          <h3 style="flex-shrink: 0; margin-bottom: 1rem;">Segment Progress</h3>
          <div class="segments-list">
            {#each progress.segments as segment, index}
              <div class="segment-item {segment.status}">
                <div class="segment-number">#{index + 1}</div>
                <div class="segment-content">
                  <div class="segment-text">
                    {segment.text?.substring(0, 100)}...
                  </div>
                  <div class="segment-meta">
                    {#if segmentDetails[index]}
                      <span class="segment-speaker">🎭 {segmentDetails[index].speaker_name || 'Unknown'}</span>
                      <span class="segment-voice">🎤 {segmentDetails[index].voice_name || 'No voice'}</span>
                    {/if}
                  </div>
                </div>
                <div class="segment-actions">
                  <div class="segment-status {segment.status}">
                    {segment.status}
                  </div>
                  
                  {#if segment.status === 'completed'}
                    <button 
                      class="segment-button play-button"
                      on:click={() => playSegment(index)}
                      disabled={playingSegments.has(index)}
                      title="Play segment"
                    >
                      {#if playingSegments.has(index)}
                        ⏸️
                      {:else}
                        ▶️
                      {/if}
                    </button>
                    
                    <button 
                      class="segment-button regenerate-button"
                      on:click={() => regenerateSegment(index)}
                      disabled={regeneratingSegments.has(index)}
                      title="Regenerate segment"
                    >
                      {#if regeneratingSegments.has(index)}
                        ⏳
                      {:else}
                        🔄
                      {/if}
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}
      
      {#if logs.length > 0}
        <div class="progress-section">
          <h3>Generation Logs</h3>
          <div class="logs-section">
            {#each logs as log}
              <div class="log-entry">
                <span class="log-timestamp">{log.timestamp.split('T')[1].split('.')[0]}</span>
                <span class="log-message">{log.message}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>