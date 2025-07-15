<script>
  import { onMount } from 'svelte';
  import { voicesStore, refreshVoices } from '../../lib/stores.js';
  
  let voices = [];
  let loading = true;
  let error = null;
  let showAddVoice = false;
  let editingVoice = null;
  let selectedProvider = 'all';
  let searchTerm = '';
  let previewingVoices = new Set(); // Track which voices are being previewed
  let downloadingVoices = new Set(); // Track which voices are being downloaded
  
  const API_URL = 'http://localhost:8383';
  
  // New voice form data
  let newVoice = {
    id: '',
    name: '',
    provider: 'elevenlabs',
    type: 'custom',
    settings: {
      voice_id: '',
      model_id: 'eleven_monolingual_v1'
    },
    tags: ''
  };
  
  let fetchingVoiceDetails = false;
  
  async function loadVoices() {
    try {
      voices = await refreshVoices();
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
  
  async function createVoice() {
    try {
      // Generate ID if not already set
      if (!newVoice.id && newVoice.settings.voice_id) {
        newVoice.id = `elevenlabs_${newVoice.settings.voice_id}`;
      }
      
      const response = await fetch(`${API_URL}/api/voices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newVoice)
      });
      
      if (!response.ok) throw new Error('Failed to create voice');
      
      showAddVoice = false;
      resetNewVoice();
      await loadVoices();
    } catch (err) {
      error = err.message;
    }
  }
  
  async function updateVoice(voice) {
    try {
      const response = await fetch(`${API_URL}/api/voices/${voice.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: voice.name,
          tags: voice.tags,
          settings: voice.settings
        })
      });
      
      if (!response.ok) throw new Error('Failed to update voice');
      
      editingVoice = null;
      await loadVoices();
    } catch (err) {
      error = err.message;
    }
  }
  
  async function deleteVoice(voiceId) {
    if (!confirm('Are you sure you want to delete this voice?')) return;
    
    try {
      const response = await fetch(`${API_URL}/api/voices/${voiceId}`, {
        method: 'DELETE'
      });
      
      if (!response.ok) throw new Error('Failed to delete voice');
      
      await loadVoices();
    } catch (err) {
      error = err.message;
    }
  }

  
  async function previewVoice(voice) {
    const previewKey = voice.id;
    if (previewingVoices.has(previewKey)) return;
    
    previewingVoices.add(previewKey);
    previewingVoices = previewingVoices; // Trigger reactivity
    
    try {
      const text = voice.preview_text || `Hello, this is a preview of the ${voice.name} voice. This voice is perfect for narrating stories and bringing characters to life.`;
      
      const response = await fetch(`${API_URL}/api/voices/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: voice.id, text })
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

  async function downloadVoicePreview(voice) {
    const downloadKey = voice.id;
    if (downloadingVoices.has(downloadKey)) return;
    
    downloadingVoices.add(downloadKey);
    downloadingVoices = downloadingVoices; // Trigger reactivity
    
    try {
      const text = voice.preview_text || `Hello, this is a voice preview for ${voice.name}. This voice is perfect for narrating stories and bringing characters to life.`;
      
      const response = await fetch(`${API_URL}/api/voices/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: voice.id, text })
      });
      
      if (!response.ok) throw new Error('Failed to generate preview');
      
      const audioBlob = await response.blob();
      
      // Create download link
      const audioUrl = URL.createObjectURL(audioBlob);
      const downloadLink = document.createElement('a');
      downloadLink.href = audioUrl;
      downloadLink.download = `${voice.name.replace(/[^a-zA-Z0-9]/g, '_')}_preview.mp3`;
      
      // Trigger download
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      
      // Clean up
      setTimeout(() => {
        URL.revokeObjectURL(audioUrl);
      }, 1000);
      
    } catch (err) {
      error = err.message;
    } finally {
      downloadingVoices.delete(downloadKey);
      downloadingVoices = downloadingVoices;
    }
  }
  
  function resetNewVoice() {
    newVoice = {
      id: '',
      name: '',
      provider: 'elevenlabs',
      type: 'custom',
      settings: {
        voice_id: '',
        model_id: 'eleven_monolingual_v1'
      },
      tags: ''
    };
  }
  
  async function fetchElevenLabsVoiceDetails() {
    if (!newVoice.settings.voice_id) return;
    
    fetchingVoiceDetails = true;
    error = null; // Clear previous errors
    try {
      const response = await fetch(`${API_URL}/api/elevenlabs/voices/${newVoice.settings.voice_id}`);
      
      if (!response.ok) {
        const errorData = await response.json();
        if (errorData.error?.includes('ELEVENLABS_API_KEY')) {
          throw new Error('ElevenLabs API key not configured. Please set ELEVENLABS_API_KEY in your .env file.');
        }
        if (errorData.error?.includes('missing_permissions')) {
          throw new Error(errorData.error);
        }
        throw new Error(errorData.error || 'Failed to fetch voice details');
      }
      
      const voiceData = await response.json();
      
      // Update form with fetched data
      newVoice = {
        ...voiceData,
        settings: {
          ...voiceData.settings,
          model_id: newVoice.settings.model_id // Keep selected model
        }
      };
      
    } catch (err) {
      error = err.message;
      // Reset voice data on error
      newVoice.name = '';
      newVoice.tags = '';
    } finally {
      fetchingVoiceDetails = false;
    }
  }
  
  $: filteredVoices = voices.filter(voice => {
    const matchesProvider = selectedProvider === 'all' || voice.provider === selectedProvider;
    const matchesSearch = !searchTerm || 
      voice.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      voice.tags?.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesProvider && matchesSearch;
  });
  
  onMount(loadVoices);
</script>

<style>
  /* Override narrow layout for voices page */
  :global(main) {
    max-width: 95% !important;
    margin: 2rem auto !important;
  }
  
  .voices-container {
    width: 100%;
    padding: 0 1rem;
  }
  
  .voices-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  .header-actions {
    display: flex;
    gap: 1rem;
    align-items: center;
  }
  
  .filters {
    display: flex;
    gap: 1rem;
    align-items: center;
    margin-bottom: 2rem;
  }
  
  .filter-select, .search-input {
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.875rem;
  }
  
  .search-input {
    flex: 1;
    max-width: 300px;
  }
  
  .voices-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
    gap: 1.5rem;
  }
  
  .voice-card {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1.5rem;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    transition: transform 0.2s, box-shadow 0.2s;
  }
  
  .voice-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(0,0,0,0.15);
  }
  
  .voice-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
  }
  
  .voice-name {
    font-size: 1.25rem;
    font-weight: 600;
    color: #333;
  }
  
  .voice-provider {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    background: #f0f0f0;
    border-radius: 12px;
    color: #666;
  }
  
  .provider-openai {
    background: #e3f2fd;
    color: #1565c0;
  }
  
  .provider-elevenlabs {
    background: #f3e5f5;
    color: #7b1fa2;
  }
  
  .provider-custom {
    background: #e8f5e9;
    color: #2e7d32;
  }
  
  .voice-tags {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  
  .tag {
    font-size: 0.75rem;
    padding: 0.2rem 0.5rem;
    background: #f5f5f5;
    border-radius: 8px;
    color: #555;
  }
  
  .voice-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  
  .action-button {
    padding: 0.5rem 1rem;
    background: #f0f0f0;
    color: #333;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: background 0.2s;
  }
  
  .action-button:hover {
    background: #e0e0e0;
  }
  
  .preview-button {
    background: #2196F3;
    color: white;
  }
  
  .preview-button:hover {
    background: #1976D2;
  }

  .download-button {
    background: #4CAF50;
    color: white;
  }

  .download-button:hover:not(:disabled) {
    background: #45a049;
  }

  .download-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  
  .edit-button {
    background: #FF9800;
    color: white;
  }
  
  .edit-button:hover {
    background: #F57C00;
  }
  
  .delete-button {
    background: #f44336;
    color: white;
  }
  
  .delete-button:hover {
    background: #d32f2f;
  }
  
  .add-button {
    background: #4CAF50;
    color: white;
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1rem;
  }
  
  .add-button:hover {
    background: #45a049;
  }
  
  /* Modal styles */
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
    max-height: 90vh;
    overflow-y: auto;
  }
  
  .modal-header {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 1.5rem;
  }
  
  .form-group {
    margin-bottom: 1.5rem;
  }
  
  .form-label {
    display: block;
    font-weight: 500;
    margin-bottom: 0.5rem;
    color: #333;
  }
  
  .form-input, .form-select, .form-textarea {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.875rem;
  }
  
  .form-textarea {
    min-height: 100px;
    resize: vertical;
  }
  
  .form-hint {
    font-size: 0.75rem;
    color: #666;
    margin-top: 0.25rem;
  }
  
  .modal-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
    margin-top: 2rem;
  }
  
  .empty-state {
    text-align: center;
    padding: 4rem;
    color: #666;
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
  
  .settings-group {
    background: #f9f9f9;
    padding: 1rem;
    border-radius: 4px;
    margin-top: 1rem;
  }
  
  .settings-title {
    font-weight: 500;
    margin-bottom: 1rem;
    color: #555;
  }
</style>

<div class="voices-container">
  <div class="voices-header">
    <h1>🎤 Voice Library</h1>
    <button class="add-button" on:click={() => showAddVoice = true}>
      ➕ Add Custom Voice
    </button>
  </div>
  
  {#if error}
    <div class="error-message">{error}</div>
  {/if}
  
  <div class="filters">
    <select class="filter-select" bind:value={selectedProvider}>
      <option value="all">All Providers</option>
      <option value="elevenlabs">ElevenLabs</option>
      <option value="custom">Custom</option>
    </select>
    
    <input 
      type="text" 
      class="search-input" 
      placeholder="Search voices by name or tags..."
      bind:value={searchTerm}
    />
  </div>
  
  {#if loading}
    <div class="loading">Loading voices...</div>
  {:else if filteredVoices.length === 0}
    <div class="empty-state">
      <h2>No voices found</h2>
      <p>Add a custom voice to get started.</p>
    </div>
  {:else}
    <div class="voices-grid">
      {#each filteredVoices as voice}
        <div class="voice-card">
          <div class="voice-header">
            <div>
              <div class="voice-name">{voice.name}</div>
              <div class="voice-provider provider-{voice.provider}">{voice.provider.toUpperCase()}</div>
            </div>
          </div>
          
          {#if voice.tags}
            <div class="voice-tags">
              {#each voice.tags.split(',') as tag}
                <span class="tag">{tag.trim()}</span>
              {/each}
            </div>
          {/if}
          
          <div class="voice-actions">
            <button 
              class="action-button preview-button" 
              on:click={() => previewVoice(voice)}
              disabled={previewingVoices.has(voice.id)}
            >
              {#if previewingVoices.has(voice.id)}
                ⏳ Generating...
              {:else}
                🎧 Preview
              {/if}
            </button>
            <button 
              class="action-button download-button" 
              on:click={() => downloadVoicePreview(voice)}
              disabled={downloadingVoices.has(voice.id)}
              title="Download MP3 preview"
            >
              {#if downloadingVoices.has(voice.id)}
                ⏳ Downloading...
              {:else}
                💾 Download
              {/if}
            </button>
            {#if voice.type === 'custom'}
              <button class="action-button edit-button" on:click={() => editingVoice = voice}>
                ✏️ Edit
              </button>
              <button class="action-button delete-button" on:click={() => deleteVoice(voice.id)}>
                🗑️ Delete
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Add Voice Modal -->
{#if showAddVoice}
  <div class="modal-backdrop" on:click={() => showAddVoice = false}>
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header">Add Custom Voice</div>
      
      <div class="form-group">
        <label class="form-label" for="voice-provider">Provider</label>
        <select id="voice-provider" class="form-select" bind:value={newVoice.provider}>
          <option value="elevenlabs">ElevenLabs</option>
          <option value="custom">Custom API</option>
        </select>
      </div>
      
      {#if newVoice.provider === 'elevenlabs'}
        <div class="settings-group">
          <div class="settings-title">ElevenLabs Voice</div>
          
          <div class="form-group">
            <label class="form-label" for="el-voice-id">Voice ID</label>
            <input 
              id="el-voice-id"
              type="text" 
              class="form-input" 
              bind:value={newVoice.settings.voice_id}
              on:blur={fetchElevenLabsVoiceDetails}
              placeholder="e.g., 21m00Tcm4TlvDq8ikWAM"
              disabled={fetchingVoiceDetails}
            />
            <p class="form-hint">Enter a voice ID from your ElevenLabs account or the Voice Library</p>
          </div>
          
          {#if fetchingVoiceDetails}
            <p style="color: #2196F3; text-align: center;">Fetching voice details...</p>
          {/if}
          
          {#if newVoice.name}
            <div class="form-group" style="background: #e8f5e9; padding: 1rem; border-radius: 4px;">
              <strong>Voice Name:</strong> {newVoice.name}<br>
              {#if newVoice.tags}
                <strong>Tags:</strong> {newVoice.tags}
              {/if}
              {#if newVoice.settings?.is_voice_library}
                <div style="margin-top: 0.5rem; color: #1976D2;">
                  <strong>Note:</strong> This is a Voice Library voice. Please enter a descriptive name below.
                </div>
              {/if}
            </div>
          {/if}
          
          {#if newVoice.settings?.is_voice_library || (newVoice.settings.voice_id && !fetchingVoiceDetails && !newVoice.name)}
            <div class="form-group">
              <label class="form-label" for="el-voice-name">Voice Name</label>
              <input 
                id="el-voice-name"
                type="text" 
                class="form-input" 
                bind:value={newVoice.name}
                placeholder="Enter a descriptive name for this voice"
              />
              <p class="form-hint">Give this voice a memorable name</p>
            </div>
          {/if}
          
          <div class="form-group">
            <label class="form-label" for="el-model">Model</label>
            <select id="el-model" class="form-select" bind:value={newVoice.settings.model_id}>
              <option value="eleven_monolingual_v1">Eleven English v1</option>
              <option value="eleven_multilingual_v1">Eleven Multilingual v1</option>
              <option value="eleven_multilingual_v2">Eleven Multilingual v2</option>
            </select>
          </div>
        </div>
      {/if}
      
      <div class="modal-actions">
        <button class="action-button" on:click={() => showAddVoice = false}>
          Cancel
        </button>
        <button 
          class="add-button" 
          on:click={createVoice}
          disabled={!newVoice.name || !newVoice.id}
        >
          Add Voice
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- Edit Voice Modal -->
{#if editingVoice}
  <div class="modal-backdrop" on:click={() => editingVoice = null}>
    <div class="modal" on:click|stopPropagation>
      <div class="modal-header">Edit Voice: {editingVoice.name}</div>
      
      <div class="form-group">
        <label class="form-label" for="edit-voice-name">Voice Name</label>
        <input 
          id="edit-voice-name"
          type="text" 
          class="form-input" 
          bind:value={editingVoice.name}
        />
      </div>
      
      <div class="form-group">
        <label class="form-label" for="edit-voice-tags">Tags</label>
        <input 
          id="edit-voice-tags"
          type="text" 
          class="form-input" 
          bind:value={editingVoice.tags}
        />
      </div>
      
      <div class="modal-actions">
        <button class="action-button" on:click={() => editingVoice = null}>
          Cancel
        </button>
        <button class="add-button" on:click={() => updateVoice(editingVoice)}>
          Save Changes
        </button>
      </div>
    </div>
  </div>
{/if}