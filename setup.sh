#!/bin/bash

echo "🎧 Audiobook MCP Server - Development Setup"
echo "=========================================="

# Check Node.js version
echo "📦 Checking Node.js version..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 18.0.0 or higher"
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -c 2-)
REQUIRED_VERSION="18.0.0"

if ! node -e "process.exit(process.version.split('.')[0] >= 18 ? 0 : 1)"; then
    echo "❌ Node.js version $NODE_VERSION is too old. Please install version $REQUIRED_VERSION or higher"
    exit 1
fi

echo "✅ Node.js version $NODE_VERSION is compatible"

# Check FFmpeg
echo "🎬 Checking FFmpeg installation..."
if ! command -v ffmpeg &> /dev/null; then
    echo "❌ FFmpeg not found. Installing instructions:"
    echo "   macOS: brew install ffmpeg"
    echo "   Ubuntu/Debian: sudo apt update && sudo apt install ffmpeg"
    echo "   Windows: Download from https://ffmpeg.org/download.html"
    echo ""
    echo "⚠️  Audio processing features will not work without FFmpeg"
    echo "   You can continue with basic functionality"
else
    FFMPEG_VERSION=$(ffmpeg -version | head -n 1 | cut -d ' ' -f 3)
    echo "✅ FFmpeg version $FFMPEG_VERSION found"
fi

# Install dependencies
echo "📚 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo "✅ Dependencies installed successfully"

# Build project
echo "🔨 Building project..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
fi

echo "✅ Project built successfully"

# Create directories
echo "📁 Setting up directories..."
mkdir -p examples
mkdir -p docs

# Check TypeScript
echo "🏗️  Checking TypeScript..."
if ! command -v npx tsc &> /dev/null; then
    echo "❌ TypeScript compiler not found"
    exit 1
fi

echo "✅ TypeScript ready"

echo ""
echo "🎉 Setup Complete!"
echo "=================="
echo ""
echo "Next steps:"
echo "1. Copy claude_desktop_config.example.json to your Claude Desktop config"
echo "2. Update the paths in the config file"
echo "3. Restart Claude Desktop"
echo "4. Test with: 'Scan my audiobooks library'"
echo ""
echo "Development commands:"
echo "  npm run dev     - Start in development mode"
echo "  npm run build   - Build for production"
echo "  npm test        - Run tests (when available)"
echo ""
echo "Happy coding! 🚀"
