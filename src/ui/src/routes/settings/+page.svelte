<script>
  import { onMount } from 'svelte';
  
  let stats = {};
  let loading = true;

  async function fetchStats() {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('Failed to fetch stats');
      stats = await response.json();
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    } finally {
      loading = false;
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  function formatDuration(seconds) {
    if (!seconds) return '0 minutes';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes} minutes`;
  }

  onMount(fetchStats);
</script>

<svelte:head>
  <title>Settings - Patreon Podcast Manager</title>
</svelte:head>

<style>
  /* Override narrow layout for settings page */
  :global(main) {
    max-width: 95% !important;
    margin: 2rem auto !important;
  }
</style>

<h1>⚙️ Settings & Stats</h1>

<div class="card">
  <h2>System Statistics</h2>
  {#if loading}
    <p>Loading stats...</p>
  {:else}
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
      <div>
        <h3>Chapters</h3>
        <p><strong>{stats.totalChapters || 0}</strong> total</p>
        <p><strong>{stats.processedChapters || 0}</strong> processed</p>
      </div>
      
      <div>
        <h3>Jobs</h3>
        <p><strong>{stats.pendingJobs || 0}</strong> pending</p>
        <p><strong>{stats.runningJobs || 0}</strong> running</p>
      </div>
      
      <div>
        <h3>Audio Content</h3>
        <p><strong>{formatDuration(stats.totalDuration)}</strong> total duration</p>
        <p><strong>{formatBytes(stats.totalSize)}</strong> total size</p>
      </div>
    </div>
  {/if}
</div>

<div class="card">
  <h2>Configuration</h2>
  <p>This system is configured through environment variables. Check your <code>.env</code> file for the following settings:</p>
  
  <h3>Required Settings</h3>
  <ul>
    <li><code>OPENAI_API_KEY</code> - Your OpenAI API key for text-to-speech</li>
    <li><code>PATREON_CREATOR_URL</code> - The Patreon creator page to scrape</li>
    <li><code>SITE_URL</code> - Your domain for RSS feed links</li>
  </ul>
  
  <h3>Optional Settings</h3>
  <ul>
    <li><code>PODCAST_TITLE</code> - Name of your podcast feed</li>
    <li><code>PODCAST_AUTHOR</code> - Author name for the podcast</li>
    <li><code>TTS_VOICE</code> - OpenAI voice (alloy, echo, fable, onyx, nova, shimmer)</li>
    <li><code>SCRAPE_DELAY_BASE_MS</code> - Base delay between requests (default: 600ms)</li>
  </ul>
</div>

<div class="card">
  <h2>Getting Started</h2>
  <ol>
    <li>Copy <code>.env.example</code> to <code>.env</code> and fill in your settings</li>
    <li>Run <code>npm run patreon:login</code> to authenticate with Patreon</li>
    <li>Use the "Sync New Chapters" button to fetch and process chapters</li>
    <li>Add <code>/feed.xml</code> to your podcast app</li>
  </ol>
</div>

<div class="card">
  <h2>Commands</h2>
  <p>You can also run these commands from the terminal:</p>
  <ul>
    <li><code>npm run patreon:login</code> - Login to Patreon</li>
    <li><code>npm run patreon:sync</code> - Sync new chapters</li>
    <li><code>npm run scrape</code> - Manual scrape</li>
    <li><code>npm run worker</code> - Process TTS jobs</li>
  </ul>
</div>