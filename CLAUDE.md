# Claude Development Workflow for Patreon-to-Audio

## 🚨 CRITICAL RULE #1: NEVER COMMIT ON MAIN BRANCH 🚨

**MANDATORY**: Always create a feature branch for any changes. NEVER commit directly to main.

```bash
# Always do this:
git checkout -b feat/your-feature-name
# Make changes
git add .
git commit -m "Your commit message"
git push origin feat/your-feature-name
```

## 🚨 CRITICAL RULE #2: ALWAYS RESTART AFTER CODE CHANGES 🚨

**MANDATORY**: After editing ANY code file, you MUST restart the affected service:

```bash
# For ANY change to src/api/ files:
./scripts/tmux-manager.sh restart server

# For ANY change to src/ui/ files: 
./scripts/tmux-manager.sh restart ui
```

**⚠️ CODE CHANGES ARE NOT ACTIVE UNTIL RESTART ⚠️**
**⚠️ NEVER ASSUME CODE CHANGES WORK WITHOUT RESTARTING ⚠️**

## Project Overview
This is a Patreon-to-Podcast system that extracts Patreon posts, processes them through a 4-stage pipeline, and generates podcast audio with multi-voice TTS.

## Tmux Management Workflow

### Always Use the Tmux Manager
**NEVER** try to start the server directly with `node src/api/server.js` or similar commands. Always use the tmux manager.

### Basic Commands

```bash
# Check status of all panes
npm run tmux status

# View logs from a specific pane
npm run tmux logs server    # Show last 20 lines from server
npm run tmux logs ui        # Show last 20 lines from UI
npm run tmux logs worker    # Show last 20 lines from worker
npm run tmux logs logs      # Show last 20 lines from logs pane

# Follow live logs (Ctrl+C to exit)
npm run tmux tail server

# Restart specific panes
npm run tmux restart server # Restart API server
npm run tmux restart ui     # Restart UI
npm run tmux restart worker # Reset worker pane
npm run tmux restart logs   # Reset logs pane

# Kill processes in a pane (use before restart if hanging)
npm run tmux kill server

# Start/stop entire session
npm run tmux start
npm run tmux stop
```

### Debugging Workflow

1. **Check Status First**
   ```bash
   npm run tmux status
   ```

2. **Check Logs for Issues**
   ```bash
   npm run tmux logs server
   npm run tmux logs ui
   ```

3. **Restart Problematic Panes**
   ```bash
   npm run tmux restart server
   ```

4. **Follow Logs to Monitor**
   ```bash
   npm run tmux tail server
   ```

### Tmux Pane Layout

- **server** (pane 0): API server running on port 8383
- **ui** (pane 1): SvelteKit UI running on port 5174  
- **worker** (pane 2): Available for manual commands
- **logs** (pane 3): Available for manual commands

## Development Process

### When Making Code Changes

1. **Check current status**
   ```bash
   npm run tmux status
   ```

2. **Make your code changes**

3. **🚨 CRITICAL: ALWAYS RESTART AFTER CODE CHANGES 🚨**
   ```bash
   # For API changes - MANDATORY RESTART
   npm run tmux restart server
   
   # For UI changes - MANDATORY RESTART  
   npm run tmux restart ui
   ```
   
   **⚠️ CODE CHANGES DO NOT TAKE EFFECT UNTIL RESTART ⚠️**
   **⚠️ ALWAYS RESTART IMMEDIATELY AFTER EDITING CODE ⚠️**

4. **Monitor logs for issues**
   ```bash
   npm run tmux logs server
   ```

### When Debugging Issues

1. **NEVER start processes manually** - always use tmux manager
2. **Check logs first** before assuming what's wrong
3. **Use kill before restart** if processes are hanging
4. **Monitor logs during operations** to see real-time feedback

## Project Architecture

### 4-Stage Pipeline
1. **Extract** - Scrape chapter text from Patreon
2. **Speaker ID** - Identify individual speakers (future)
3. **Generate** - Create multi-voice TTS audio (future)
4. **Publish** - Generate RSS feed and sync to S3

### Key Files
- `src/api/server.js` - Main API server with WebSocket logging
- `src/scraper/scraper.js` - Patreon scraping with Playwright
- `src/ui/` - SvelteKit web interface
- `scripts/tmux-manager.sh` - Tmux management script

### Ports
- **8383** - API server
- **5174** - UI server

## Important Notes

### Browser Issues
- Playwright runs in headless mode to avoid display issues
- Browser initialization can fail - check server logs
- Session persistence is maintained in `.patreon-session/`

### Logging
- Real-time logs appear in the UI bottom panel via WebSocket
- Use tmux manager to check individual pane logs
- All operations are logged with timestamps and emojis

### Chapter Management
- Load chapters one at a time using "Load Next Chapter" button
- Delete unwanted chapters with 🗑️ button
- No bulk operations - controlled individual loading

## Troubleshooting

### Server Won't Start
```bash
npm run tmux logs server
npm run tmux kill server
npm run tmux restart server
```

### UI Not Loading
```bash
npm run tmux logs ui
npm run tmux restart ui
```

### WebSocket Errors
Usually means server crashed:
```bash
npm run tmux status
npm run tmux logs server
npm run tmux restart server
```

### Browser Initialization Fails
Check server logs for Playwright errors:
```bash
npm run tmux logs server
```

## UI Layout Guidelines

### Page Width Configuration
**CRITICAL**: All pages MUST use 95% width layout to avoid narrow content areas.

**Required CSS for every page component:**
```css
/* Override narrow layout for [page name] */
:global(main) {
  max-width: 95% !important;
  margin: 2rem auto !important;
}
```

**Container setup:**
```css
.page-container {
  width: 100%;
  padding: 0 1rem;
}
```

### Lightbox Width Standards
**CRITICAL**: ALL lightboxes MUST use consistent wide layouts.

**Required CSS for every lightbox component:**
```css
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
```

**NEVER create narrow lightboxes** - always use 90% width with no max-width constraint.

**Lightbox content should:**
- Fill available space with proper flex layouts
- Use scrollable areas for long content
- Maintain consistent padding (1.5rem)
- Use flex: 1 to fill vertical space

**Pages and lightboxes that have been fixed:**
- ✅ Episodes page (`src/ui/src/routes/+page.svelte`)
- ✅ Character Dashboard (`src/ui/src/routes/CharacterDashboard.svelte`)
- ✅ Settings page (`src/ui/src/routes/settings/+page.svelte`)
- ✅ ChapterLightbox (`src/ui/src/routes/ChapterLightbox.svelte`)
- ✅ GenerationProgressLightbox (`src/ui/src/routes/GenerationProgressLightbox.svelte`)

**NEVER create narrow layouts** - always use the full width patterns above.

## Character Aliases and Pronunciations

### Character Configuration File

The system uses `character-config.json` to manage character aliases and pronunciation rules:

```json
{
  "characterAliases": {
    "Vilastromoz": {
      "aliases": ["Villy", "the Malefic Viper", "Vilas", "Malefic Viper"],
      "description": "Ancient Primordial, appears as both snake and humanoid form"
    }
  },
  "pronunciations": {
    "lvl": "level",
    "malefic": "muh-lef-ik"
  }
}
```

### Adding New Characters and Pronunciations

**Character Aliases:**
- Add characters who have multiple names/nicknames
- GPT will use the main character name consistently
- Improves speaker identification accuracy

**Pronunciations:**
- Fix common mispronunciations in TTS
- Automatically generates case variations (lvl, LVL, Lvl)
- Applied during text preprocessing before TTS

### Usage
1. Edit `character-config.json` 
2. Restart server: `npm run tmux restart server`
3. Changes apply to all new speaker identification

Remember: **Always use the tmux manager, never start processes manually!**