# LitRPG-to-Podcast

A comprehensive system that extracts LitRPG web fiction from multiple sources (Patreon, Royal Road) and converts them into high-quality multi-voice podcast audio with automated RSS feed publishing.

## Features

- 🎭 **Multi-Voice TTS**: Automatic speaker identification and voice assignment using OpenAI TTS
- 📝 **Multi-Source Integration**: Automated chapter extraction from Patreon and Royal Road
- 🎙️ **Segment Caching**: Permanent audio segment storage with individual regeneration capability
- 📡 **RSS Publishing**: Apple Podcasts-compliant RSS feeds with S3 integration
- 🖥️ **Web Interface**: Full-featured management dashboard built with SvelteKit
- 🔍 **Debug Tools**: Comprehensive audio merge debugging and analysis

## Architecture

### 4-Stage Pipeline

1. **Extract** - Scrape chapter text from Patreon or Royal Road using Playwright
2. **Speaker ID** - Identify and assign voices to individual speakers 
3. **Generate** - Create multi-voice TTS audio with segment caching
4. **Publish** - Generate RSS feed and sync to S3 for podcast distribution

### Technology Stack

- **Backend**: Node.js with Fastify
- **Frontend**: SvelteKit
- **Database**: SQLite
- **TTS**: OpenAI Text-to-Speech API
- **Audio Processing**: FFmpeg
- **Cloud Storage**: AWS S3
- **Session Management**: Tmux for process orchestration

## Quick Start

### Prerequisites

- Node.js 18+
- FFmpeg
- AWS CLI (for S3 publishing)
- OpenAI API key

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd litrpg-to-podcast
```

2. Install dependencies:
```bash
npm install
cd src/ui && npm install && cd ../..
```

3. Copy environment configuration:
```bash
cp .env.example .env
```

4. Configure your environment variables in `.env`:
```bash
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key

# Content Source Configuration
CONTENT_SOURCE=royalroad  # or 'patreon'
START_FROM_CHAPTER=986    # starting chapter number

# Patreon Configuration (if using Patreon source)
PATREON_USERNAME=your_username
PATREON_PASSWORD=your_password

# S3 Configuration (optional)
AWS_PROFILE=your_aws_profile
S3_BUCKET=your_bucket_name
```

### Running the Application

**Always use the tmux manager - never start processes manually:**

```bash
# Start the full system
npm run tmux start

# Check status
npm run tmux status

# View logs
npm run tmux logs server
npm run tmux logs ui

# Restart individual components
npm run tmux restart server
npm run tmux restart ui
```

The application will be available at:
- **Web Interface**: http://localhost:5174
- **API Server**: http://localhost:8383

## Usage

### Basic Workflow

1. **Load Chapters**: Use "Load Next Chapter" to extract new content from configured source
2. **Speaker Assignment**: Review and assign voices to identified speakers
3. **Generate Audio**: Create TTS audio with automatic segment caching
4. **Publish**: Generate RSS feed and sync to S3 for podcast distribution

### Web Interface

- **Episodes Dashboard**: View all chapters and their processing status
- **Character Dashboard**: Manage speakers and voice assignments
- **Settings**: Configure system preferences

### Audio Management

- **Segment Caching**: All TTS segments are permanently cached for efficient regeneration
- **Individual Regeneration**: Regenerate specific segments without rebuilding entire chapters
- **Debug Tools**: Comprehensive merge debugging to investigate audio issues

### Publishing

The system generates Apple Podcasts-compliant RSS feeds with:
- Proper iTunes namespace and metadata
- Chapter-based episode structure
- Automatic S3 sync for web distribution

## Development

### Project Structure

```
src/
├── api/           # Fastify API server
├── scraper/       # Multi-source content extraction (Patreon, Royal Road)
├── worker/        # TTS and audio processing
├── shared/        # Common utilities and configuration
└── ui/           # SvelteKit web interface

scripts/          # Tmux management and utilities
public/           # Generated output files
db/              # SQLite database files
```

### Key Files

- `src/api/server.js` - Main API server with WebSocket logging
- `src/scraper/scraper-factory.js` - Multi-source scraper factory (Patreon, Royal Road)
- `src/worker/multi-voice-tts.js` - TTS generation and audio processing
- `src/ui/` - SvelteKit web interface
- `scripts/tmux-manager.sh` - Process management script

### Configuration

System configuration is managed through:
- `src/shared/config.js` - Main configuration file
- `.env` - Environment variables
- `CLAUDE.md` - Development workflow documentation

## Troubleshooting

### Common Issues

**Server Won't Start**:
```bash
npm run tmux logs server
npm run tmux restart server
```

**Browser Initialization Fails**:
Check server logs for Playwright errors - browser runs in headless mode.

**Audio Generation Issues**:
Use the Debug Merge functionality in the Generate tab to analyze FFmpeg output.

### Debug Tools

- **Real-time Logs**: Available in UI bottom panel via WebSocket
- **Debug Merge**: Detailed FFmpeg analysis for audio issues
- **Tmux Manager**: Process monitoring and log access

## Contributing

1. Follow the tmux workflow documented in `CLAUDE.md`
2. Use the 95% width layout standard for all UI pages
3. Test changes using the debug tools provided
4. Ensure audio segments cache properly

## License

[License information]

## Acknowledgments

Built for converting LitRPG and serialized web fiction into podcast format with high-quality multi-voice narration. Supports multiple content sources including Patreon and Royal Road.