<script>
  import './styles.css';
  import { onMount, onDestroy } from 'svelte';
  
  let logs = [];
  let ws = null;
  let connected = false;
  let logContainer;
  let autoScroll = true;
  let logHeight = 200; // Default height
  let isResizing = false;
  let startY = 0;
  let startHeight = 0;
  
  const API_URL = 'ws://localhost:8383';
  const MAX_LOGS = 100; // Keep last 100 logs
  const MIN_HEIGHT = 100;
  let MAX_HEIGHT = 600; // Default fallback
  
  function connectWebSocket() {
    try {
      ws = new WebSocket(`${API_URL}/api/logs`);
      
      ws.onopen = () => {
        connected = true;
      };
      
      ws.onmessage = (event) => {
        try {
          const log = JSON.parse(event.data);
          logs = [...logs.slice(-MAX_LOGS + 1), log];
          
          if (autoScroll && logContainer) {
            setTimeout(() => {
              logContainer.scrollTop = logContainer.scrollHeight;
            }, 10);
          }
        } catch (error) {
          console.error('Failed to parse log message:', error);
        }
      };
      
      ws.onclose = () => {
        connected = false;
        setTimeout(connectWebSocket, 3000);
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
      
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
    }
  }
  
  function clearLogs() {
    logs = [];
  }
  
  function getLogClass(level) {
    switch(level?.toLowerCase()) {
      case 'error': return 'log-error';
      case 'warning': return 'log-warning';
      case 'debug': return 'log-debug';
      default: return 'log-info';
    }
  }
  
  function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }
  
  function startResize(event) {
    isResizing = true;
    startY = event.clientY;
    startHeight = logHeight;
    
    document.addEventListener('mousemove', handleResize);
    document.addEventListener('mouseup', stopResize);
    event.preventDefault();
  }
  
  function handleResize(event) {
    if (!isResizing) return;
    
    const deltaY = startY - event.clientY; // Inverted because we're dragging up
    const newHeight = Math.min(Math.max(startHeight + deltaY, MIN_HEIGHT), MAX_HEIGHT);
    logHeight = newHeight;
  }
  
  function stopResize() {
    isResizing = false;
    document.removeEventListener('mousemove', handleResize);
    document.removeEventListener('mouseup', stopResize);
  }
  
  onMount(() => {
    // Set proper max height in browser
    MAX_HEIGHT = window.innerHeight * 0.8;
    connectWebSocket();
  });
  
  onDestroy(() => {
    if (ws) {
      ws.close();
    }
  });
</script>

<style>
  .app-with-logs {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
  
  .app-content {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  
  .log-viewer-container {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: #1e1e1e;
    border-top: 2px solid #333;
    display: flex;
    flex-direction: column;
    z-index: 100;
  }
  
  .resize-handle {
    height: 4px;
    background: #333;
    cursor: ns-resize;
    position: relative;
    flex-shrink: 0;
  }
  
  .resize-handle:hover {
    background: #555;
  }
  
  .resize-handle::before {
    content: '';
    position: absolute;
    top: -2px;
    left: 0;
    right: 0;
    height: 8px;
  }
  
  .log-viewer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 1rem;
    background: #252525;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
  }
  
  .log-viewer-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: #d4d4d4;
    font-weight: 500;
  }
  
  .status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #666;
  }
  
  .status-indicator.connected {
    background: #4caf50;
  }
  
  .log-viewer-controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  
  .log-control-button {
    padding: 0.25rem 0.5rem;
    background: #333;
    color: #d4d4d4;
    border: 1px solid #444;
    border-radius: 3px;
    font-size: 0.75rem;
    cursor: pointer;
  }
  
  .log-control-button:hover {
    background: #444;
  }
  
  .log-viewer-content {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
    font-family: 'Courier New', monospace;
    font-size: 0.75rem;
    line-height: 1.4;
  }
  
  .log-entry {
    margin-bottom: 0.125rem;
    word-wrap: break-word;
  }
  
  .log-timestamp {
    color: #888;
    margin-right: 0.5rem;
  }
  
  .log-level {
    font-weight: bold;
    margin-right: 0.5rem;
    text-transform: uppercase;
    font-size: 0.7rem;
  }
  
  .log-info { color: #4fc3f7; }
  .log-warning { color: #ffb74d; }
  .log-error { color: #e57373; }
  .log-debug { color: #9575cd; }
  
  .log-message {
    color: #d4d4d4;
  }
  
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: #d4d4d4;
  }
  
  .checkbox-label input {
    margin: 0;
  }
</style>

<div class="app-with-logs">
  <div class="app-content" style="margin-bottom: {logHeight}px;">
    <header>
      <h1>🎧 Patreon Podcast Manager</h1>
      <nav>
        <a href="/">Episodes</a>
        <a href="/characters">Characters</a>
        <a href="/voices">Voices</a>
        <a href="/settings">Settings</a>
      </nav>
    </header>

    <main>
      <slot />
    </main>

    <footer>
      <p>Patreon-to-Podcast • Self-hosted audio conversion</p>
    </footer>
  </div>
  
  <div class="log-viewer-container" style="height: {logHeight}px;">
    <div class="resize-handle" on:mousedown={startResize}></div>
    <div class="log-viewer-header">
      <div class="log-viewer-title">
        <div class="status-indicator" class:connected></div>
        <span>Logs</span>
      </div>
      <div class="log-viewer-controls">
        <label class="checkbox-label">
          <input type="checkbox" bind:checked={autoScroll} />
          Auto-scroll
        </label>
        <button class="log-control-button" on:click={clearLogs}>Clear</button>
      </div>
    </div>
    <div class="log-viewer-content" bind:this={logContainer}>
      {#each logs as log}
        <div class="log-entry">
          <span class="log-timestamp">{formatTimestamp(log.timestamp)}</span>
          <span class="log-level {getLogClass(log.level)}">[{log.level}]</span>
          <span class="log-message">{log.message}</span>
        </div>
      {/each}
    </div>
  </div>
</div>