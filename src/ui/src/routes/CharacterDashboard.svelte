<script>
  import { onMount } from 'svelte';
  import { voicesStore, refreshVoices } from '../lib/stores.js';
  
  let characters = [];
  let voices = [];
  let loading = true;
  let error = null;
  let selectedCharacter = null;
  let affectedChapters = [];
  let showMergeDialog = false;
  let mergeFrom = null;
  let mergeTo = null;
  
  const API_URL = 'http://localhost:8383';
  
  async function loadCharacters() {
    try {
      // Load both characters and voices in parallel
      const [charactersResponse] = await Promise.all([
        fetch(`${API_URL}/api/characters/dashboard`),
        refreshVoices()
      ]);
      
      if (!charactersResponse.ok) throw new Error('Failed to load characters');
      
      characters = await charactersResponse.json();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }
  
  // Subscribe to voices store for real-time updates
  voicesStore.subscribe(value => {
    voices = value;
  });
  
  async function assignVoice(speakerId, voiceId, voiceName) {
    try {
      const response = await fetch(`${API_URL}/api/speakers/${speakerId}/voice`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId, voiceName })
      });
      
      if (!response.ok) throw new Error('Failed to assign voice');
      
      // Show affected chapters
      await checkAffectedChapters(speakerId);
      
      // Update local data
      characters = characters.map(char => 
        char.speaker_id === speakerId 
          ? { ...char, voice_id: voiceId, voice_name: voiceName }
          : char
      );
      
    } catch (err) {
      error = err.message;
    }
  }
  
  async function checkAffectedChapters(speakerId) {
    try {
      const response = await fetch(`${API_URL}/api/speakers/${speakerId}/affected-chapters`);
      if (!response.ok) throw new Error('Failed to check affected chapters');
      
      affectedChapters = await response.json();
      selectedCharacter = characters.find(c => c.speaker_id === speakerId);
      
    } catch (err) {
      error = err.message;
    }
  }
  
  async function mergeCharacters() {
    if (!mergeFrom || !mergeTo) return;
    
    try {
      const response = await fetch(`${API_URL}/api/speakers/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          fromSpeakerId: mergeFrom.speaker_id, 
          toSpeakerId: mergeTo.speaker_id 
        })
      });
      
      if (!response.ok) throw new Error('Failed to merge characters');
      
      showMergeDialog = false;
      mergeFrom = null;
      mergeTo = null;
      
      // Reload data
      await loadCharacters();
      
    } catch (err) {
      error = err.message;
    }
  }
  
  async function previewVoice(voiceId, text) {
    try {
      const response = await fetch(`${API_URL}/api/voices/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId, text })
      });
      
      if (!response.ok) throw new Error('Failed to generate preview');
      
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.play();
      
    } catch (err) {
      error = err.message;
    }
  }
  
  async function deleteCharacter(character) {
    const confirmMessage = character.total_segments > 0 
      ? `${character.speaker_name} appears in ${character.total_segments} segments across ${character.chapter_count} chapters. Are you sure you want to delete this character? This will remove all their dialogue segments.`
      : `Are you sure you want to delete ${character.speaker_name}?`;
      
    if (!confirm(confirmMessage)) return;
    
    try {
      const force = character.total_segments > 0 ? '?force=true' : '';
      const response = await fetch(`${API_URL}/api/speakers/${character.speaker_id}${force}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to delete character');
      }
      
      // Reload characters
      await loadCharacters();
      
    } catch (err) {
      error = err.message;
    }
  }
  
  function closeAffectedChapters() {
    selectedCharacter = null;
    affectedChapters = [];
  }
  
  onMount(() => {
    loadCharacters();
  });
</script>

<style>
  /* Override narrow layout for character dashboard */
  :global(main) {
    max-width: 95% !important;
    margin: 2rem auto !important;
  }
  
  .dashboard-container {
    width: 100%;
    padding: 0 1rem;
  }
  
  .dashboard-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }
  
  .characters-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
    gap: 1.5rem;
  }
  
  .character-card {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1.5rem;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  }
  
  .character-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
  }
  
  .character-name {
    font-size: 1.25rem;
    font-weight: 600;
    color: #333;
  }
  
  .narrator-badge {
    background: #4CAF50;
    color: white;
    font-size: 0.7rem;
    padding: 0.2rem 0.5rem;
    border-radius: 12px;
    margin-left: 0.5rem;
    font-weight: 500;
  }
  
  .character-stats {
    display: flex;
    gap: 1rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    color: #666;
  }
  
  .voice-section {
    margin-bottom: 1rem;
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
  }
  
  .preview-button:hover {
    background: #1976D2;
  }
  
  .chapters-list {
    font-size: 0.875rem;
  }
  
  .chapter-link {
    color: #1976D2;
    text-decoration: none;
    margin-right: 0.5rem;
  }
  
  .chapter-link:hover {
    text-decoration: underline;
  }
  
  .merge-button {
    background: #FF9800;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
  }
  
  .merge-button:hover {
    background: #F57C00;
  }
  
  .modal-backdrop {
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
  
  .modal {
    background: white;
    padding: 2rem;
    border-radius: 8px;
    max-width: 600px;
    width: 90%;
  }
  
  .modal-header {
    font-size: 1.25rem;
    font-weight: 600;
    margin-bottom: 1rem;
  }
  
  .modal-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
    margin-top: 1.5rem;
  }
  
  .primary-button {
    background: #4CAF50;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
  }
  
  .secondary-button {
    background: #f5f5f5;
    color: #333;
    border: 1px solid #ddd;
    padding: 0.75rem 1.5rem;
    border-radius: 4px;
    cursor: pointer;
  }
  
  .error-message {
    background: #ffebee;
    color: #c62828;
    padding: 1rem;
    border-radius: 4px;
    margin-bottom: 1rem;
  }
  
  .loading {
    text-align: center;
    padding: 4rem;
    color: #666;
  }
  
  .voice-assignment {
    color: #4CAF50;
    font-size: 0.875rem;
    margin-top: 0.25rem;
  }
  
  .voice-provider {
    color: #999;
    font-size: 0.8rem;
  }
  
  .character-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid #e0e0e0;
  }
  
  .delete-character-button {
    background: #f44336;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
  }
  
  .delete-character-button:hover {
    background: #d32f2f;
  }
</style>

<div class="dashboard-container">
  <div class="dashboard-header">
    <h1>Character Dashboard</h1>
    <button class="merge-button" on:click={() => showMergeDialog = true}>
      🔀 Merge Characters
    </button>
  </div>
  
  {#if error}
    <div class="error-message">{error}</div>
  {/if}
  
  {#if loading}
    <div class="loading">Loading characters...</div>
  {:else}
    <div class="characters-grid">
      {#each characters as character}
        <div class="character-card">
          <div class="character-header">
            <div>
              <div class="character-name">
                {character.speaker_name}
                {#if character.is_narrator}
                  <span class="narrator-badge">NARRATOR</span>
                {/if}
              </div>
              <div class="character-stats">
                <span>📖 {character.chapter_count} chapters</span>
                <span>💬 {character.total_segments} segments</span>
              </div>
            </div>
          </div>
          
          <div class="voice-section">
            <div class="voice-controls">
              <select 
                class="voice-select"
                value={character.voice_id || ''}
                on:change={(e) => {
                  const voiceId = e.target.value;
                  const selectedVoice = voices.find(v => v.id === voiceId);
                  if (voiceId && selectedVoice) {
                    assignVoice(character.speaker_id, voiceId, selectedVoice.name);
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
              
              {#if character.voice_id}
                <button 
                  class="preview-button"
                  on:click={() => previewVoice(character.voice_id, "Hello, this is a voice preview for " + character.speaker_name)}
                >
                  🎧 Preview
                </button>
              {/if}
            </div>
            
            {#if character.voice_name}
              <div class="voice-assignment">
                🎤 Voice: {character.voice_name}
                {#if voices.find(v => v.id === character.voice_id)}
                  <span class="voice-provider">({voices.find(v => v.id === character.voice_id).provider})</span>
                {/if}
              </div>
            {/if}
          </div>
          
          <div class="chapters-list">
            <strong>Appears in:</strong><br>
            {#each character.chapter_titles as title, i}
              <a href="#" class="chapter-link">{title}</a>
            {/each}
          </div>
          
          <div class="character-actions">
            <button 
              class="delete-character-button"
              on:click={() => deleteCharacter(character)}
              title="Delete this character"
            >
              🗑️ Delete Character
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Merge Characters Dialog -->
{#if showMergeDialog}
  <div class="modal-backdrop" on:click={() => showMergeDialog = false}>
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header">Merge Characters</div>
      
      <p>Merge duplicate characters (e.g., "Villy" and "Malefic Viper" are the same character).</p>
      
      <div style="margin: 1rem 0;">
        <label>From (will be deleted):</label>
        <select bind:value={mergeFrom}>
          <option value={null}>Select character to merge from...</option>
          {#each characters as char}
            <option value={char}>{char.speaker_name}</option>
          {/each}
        </select>
      </div>
      
      <div style="margin: 1rem 0;">
        <label>To (will keep):</label>
        <select bind:value={mergeTo}>
          <option value={null}>Select character to merge into...</option>
          {#each characters as char}
            <option value={char}>{char.speaker_name}</option>
          {/each}
        </select>
      </div>
      
      <div class="modal-actions">
        <button class="secondary-button" on:click={() => showMergeDialog = false}>
          Cancel
        </button>
        <button 
          class="primary-button" 
          on:click={mergeCharacters}
          disabled={!mergeFrom || !mergeTo || mergeFrom.speaker_id === mergeTo.speaker_id}
        >
          Merge Characters
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Affected Chapters Dialog -->
{#if selectedCharacter && affectedChapters.length > 0}
  <div class="modal-backdrop" on:click={closeAffectedChapters}>
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header">Voice Change Impact</div>
      
      <p>Changing the voice for <strong>{selectedCharacter.speaker_name}</strong> will affect these already-generated chapters:</p>
      
      <ul>
        {#each affectedChapters as chapter}
          <li>{chapter.title}</li>
        {/each}
      </ul>
      
      <p>You'll need to regenerate these chapters to use the new voice.</p>
      
      <div class="modal-actions">
        <button class="primary-button" on:click={closeAffectedChapters}>
          Got it
        </button>
      </div>
    </div>
  </div>
{/if}