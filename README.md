# 🎧 Audiobook Library MCP Server

> **Advanced MCP server for intelligent audiobook library management with AI-powered pattern recognition, web lookup capabilities, and audio processing features.**

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Claude MCP](https://img.shields.io/badge/Claude-MCP-orange?style=for-the-badge)](https://modelcontextprotocol.io/)

## ✨ Features

### 🧠 **AI-Powered Intelligence**
- **Web Lookup Integration** - Identifies books using Google Books, Open Library, and more
- **Advanced Pattern Recognition** - Learns your organizational preferences
- **Smart Entity Recognition** - Extracts authors, titles, series from any filename format
- **Intelligent Suggestions** - Context-aware recommendations with confidence scoring

### 🎵 **Audio Processing** 
- **MP3 Combination** - Merge multiple files with lossless concatenation
- **M4B Audiobook Creation** - Professional audiobooks with metadata and chapters
- **Format Conversion** - Support for MP3, M4A, FLAC, OGG → M4B
- **Automatic Chapter Markers** - Generated from individual files

### 📚 **Library Management**
- **Audiobookshelf Compatibility** - Perfect integration with Audiobookshelf
- **Intelligent Organization** - Author-first, series-first, or hybrid structures
- **Bulk Operations** - Process hundreds of files efficiently
- **Archive Handling** - Extract ZIP, RAR, 7Z files automatically

### 🔍 **Advanced Analysis**
- **Filename Intelligence** - Handles any naming convention
- **Metadata Enhancement** - Combines file metadata with web sources
- **Confidence Scoring** - Reliability ratings for all suggestions
- **Learning System** - Gets smarter with every interaction

## 🚀 Quick Start

### Prerequisites

```bash
# Install FFmpeg (required for audio processing)
brew install ffmpeg  # macOS
# or visit https://ffmpeg.org/download.html

# Verify installation
ffmpeg -version
```

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/audiobook-mcp-server.git
cd audiobook-mcp-server

# Install dependencies
npm install

# Build the project
npm run build
```

### Configuration

1. **Set up Claude Desktop configuration** at `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "audiobook-library": {
      "command": "node",
      "args": ["/path/to/audiobook-mcp-server/dist/index.js"],
      "env": {
        "AUDIOBOOK_ROOT": "/path/to/your/audiobook/library"
      }
    }
  }
}
```

2. **Restart Claude Desktop**

3. **Test the connection:**
   ```
   "Scan my audiobooks library"
   ```

## 💡 Usage Examples

### Basic Operations
```
"Scan my audiobooks library"
"Analyze my Temp folder and suggest integration"
"Extract archive files in [folder]"
```

### AI-Powered Analysis
```
"Analyze this filename using web lookup: 'HP1_sorcerers_stone_jim_dale.mp3'"
"Bulk analyze my messy files and suggest proper names"
"Get smart suggestions for organizing my library"
```

### Audio Processing
```
"Combine the MP3 files in this folder into one audiobook"
"Create an M4B audiobook with metadata and chapters"
"Convert this series to M4B format with proper naming"
```

### Learning & Preferences
```
"Learn from this action: I renamed the file to include the author"
"Update my preferences: I prefer author-first organization"
"Show me insights about my organizing patterns"
```

## 🛠️ Available Tools

| Tool | Description |
|------|-------------|
| `scan_library` | Recursively scan audiobook directories |
| `intelligent_filename_analysis` | Analyze filenames using web lookups |
| `smart_entity_recognition` | Identify authors, titles, series from names |
| `web_lookup_book` | Query web sources for book information |
| `bulk_filename_enrichment` | Mass analyze and suggest improvements |
| `combine_mp3_files` | Merge multiple MP3s into single file |
| `create_m4b_audiobook` | Convert to M4B with metadata and chapters |
| `analyze_patterns` | Deep analysis of library patterns |
| `smart_suggestions` | AI-powered organization recommendations |
| `learn_from_action` | Record user actions for learning |

## 🌍 Web Sources

- **Google Books API** - Comprehensive book database
- **Open Library** - Open-source book information  
- **LibriVox** - Public domain audiobooks
- **Audible** - Audiobook-specific data (limited)

## 🏗️ Architecture

```
src/
├── index.ts                 # Main MCP server implementation
├── WebLookupEngine         # Web API integration and caching
├── PatternRecognizer       # AI pattern detection and learning
├── SmartSuggestionEngine   # Intelligent recommendation system
└── AudiobookMCPServer      # Core server with all tool implementations
```

## 📊 Data Storage

The server creates these files in your audiobook root directory:

- `.mcp_learning_data.json` - Pattern recognition and user actions
- `.mcp_user_preferences.json` - Explicit user preferences  
- `.mcp_lookup_cache.json` - Cached web lookup results (7-day expiry)

**All data stays local on your system** - no external data transmission except for web API queries.

## 🔧 Development

```bash
# Development mode with auto-reload
npm run dev

# Build for production
npm run build

# Test the built server
node dist/index.js
```

## 📋 Requirements

- **Node.js** 18.0.0 or higher
- **FFmpeg** (for audio processing)
- **TypeScript** 5.0.0 or higher
- **Claude Desktop** (for MCP integration)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Model Context Protocol](https://modelcontextprotocol.io/) for the MCP framework
- [Google Books API](https://developers.google.com/books) for book data
- [Open Library](https://openlibrary.org/) for open-source book information
- [FFmpeg](https://ffmpeg.org/) for audio processing capabilities
- [Audiobookshelf](https://www.audiobookshelf.org/) for inspiration on audiobook organization

## 📧 Support

If you encounter issues or have questions:

1. Check the [Issues](https://github.com/yourusername/audiobook-mcp-server/issues) page
2. Create a new issue with detailed information
3. Include your system information and error logs

---

**Transform your chaotic audiobook collection into a perfectly organized, AI-enhanced library!** 🎧✨
