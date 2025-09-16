#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { parseFile, IAudioMetadata, ICommonTagsResult } from 'music-metadata';

const execAsync = promisify(exec);

// Configuration
const AUDIOBOOK_ROOT = process.env.AUDIOBOOK_ROOT || '/Volumes/Audio';
const SUPPORTED_AUDIO_FORMATS = ['.m4b', '.mp3', '.m4a', '.flac', '.ogg'];
const SUPPORTED_ARCHIVE_FORMATS = ['.zip', '.rar', '.7z'];
const TEMP_DIR = path.join(AUDIOBOOK_ROOT, 'Temp', 'processing');
const LEARNING_DATA_FILE = path.join(AUDIOBOOK_ROOT, '.mcp_learning_data.json');
const USER_PREFERENCES_FILE = path.join(AUDIOBOOK_ROOT, '.mcp_user_preferences.json');
const LOOKUP_CACHE_FILE = path.join(AUDIOBOOK_ROOT, '.mcp_lookup_cache.json');

// Web lookup configuration
const LOOKUP_SOURCES = {
  GOOGLE_BOOKS: 'https://www.googleapis.com/books/v1/volumes',
  AUDIBLE: 'https://www.audible.com/search',
  OPENLIBRARY: 'https://openlibrary.org/search.json',
  GOODREADS: 'https://www.goodreads.com/search',
  LIBRIVOX: 'https://librivox.org/api/feed/audiobooks'
};

// Audiobookshelf naming conventions
const AUDIOBOOKSHELF_PATTERNS = {
  // Preferred structures
  AUTHOR_BASED: 'Authors/{Author}/{Series - }{Book ## - }{Title}',
  SERIES_BASED: 'Series/{Series}/{Book ## - }{Title}',
  STANDALONE: 'Authors/{Author}/{Title}',
  
  // Valid filename patterns
  FILENAME_PATTERNS: [
    /^(?:(\d{2,3})\s*[-–]\s*)?(.+)$/,  // "01 - Title" or "Title"
    /^(?:book\s*(\d+)\s*[-–]\s*)?(.+)$/i,  // "Book 1 - Title"
    /^(.+?)\s*[-–]\s*(?:book\s*)?(\d+)$/i,  // "Title - Book 1"
  ],
  
  // Forbidden characters in filenames
  INVALID_CHARS: /[<>:"|?*\\]/g,
  
  // Maximum path lengths
  MAX_FILENAME_LENGTH: 255,
  MAX_PATH_LENGTH: 260
};

// Audiobookshelf structure validation rules
interface AudiobookshelfStructure {
  isValid: boolean;
  issues: string[];
  suggestions: string[];
  recommendedPath?: string;
  confidence: number;
}

interface NamingConvention {
  pattern: string;
  description: string;
  example: string;
  validate: (path: string) => boolean;
}

interface AudiobookMetadata {
  title?: string;
  author?: string;
  narrator?: string;
  series?: string;
  seriesNumber?: number;
  duration?: number;
  genre?: string;
  publisher?: string;
  releaseDate?: string;
  description?: string;
  language?: string;
  isbn?: string;
  confidence: number; // How confident we are in the metadata (0-1)
  source: 'metadata' | 'filename' | 'directory' | 'mixed';
}

interface FileInfo {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
  extension?: string;
  metadata?: AudiobookMetadata;
}

// New interfaces for pattern recognition and learning
interface UserAction {
  id: string;
  timestamp: number;
  actionType: 'rename' | 'move' | 'organize' | 'convert' | 'metadata_edit' | 'structure_change';
  context: {
    originalPath: string;
    newPath?: string;
    metadata?: any;
    reasoning?: string;
  };
  outcome: 'accepted' | 'rejected' | 'modified';
  userFeedback?: string;
}

interface Pattern {
  id: string;
  type: 'naming' | 'organization' | 'metadata' | 'conversion' | 'series_detection';
  pattern: string | RegExp;
  confidence: number;
  frequency: number;
  lastSeen: number;
  context: any;
  examples: string[];
}

interface UserPreference {
  category: string;
  preference: string;
  strength: number; // 0-1, how strongly the user prefers this
  adaptability: number; // 0-1, how willing to adapt this preference
  lastUpdated: number;
  examples: string[];
}

interface LearningData {
  version: string;
  userActions: UserAction[];
  detectedPatterns: Pattern[];
  suggestions: SuggestionRecord[];
  statistics: {
    totalActions: number;
    acceptanceRate: number;
    commonPatterns: string[];
    preferredStructures: string[];
  };
}

interface SuggestionRecord {
  id: string;
  timestamp: number;
  type: string;
  suggestion: any;
  confidence: number;
  reasoning: string;
  accepted: boolean;
  feedback?: string;
}

interface SmartSuggestion {
  id: string;
  type: 'rename' | 'move' | 'convert' | 'organize' | 'metadata';
  description: string;
  action: any;
  confidence: number;
  reasoning: string;
  patterns: string[];
  alternatives?: SmartSuggestion[];
}

// New interfaces for web lookup functionality
interface WebLookupResult {
  source: string;
  confidence: number;
  data: {
    title?: string;
    author?: string;
    series?: string;
    seriesNumber?: number;
    narrator?: string;
    isbn?: string;
    publisher?: string;
    publishedDate?: string;
    description?: string;
    genre?: string[];
    duration?: number;
    language?: string;
    coverUrl?: string;
  };
  raw?: any;
}

interface LookupCache {
  [key: string]: {
    timestamp: number;
    results: WebLookupResult[];
    query: string;
    expiresAt: number;
  };
}

interface EntityRecognition {
  type: 'author' | 'title' | 'series' | 'narrator' | 'unknown';
  value: string;
  confidence: number;
  source: 'pattern' | 'lookup' | 'metadata' | 'mixed';
  alternatives?: string[];
}

interface ParsedFilename {
  originalName: string;
  entities: EntityRecognition[];
  structure: {
    hasNumber: boolean;
    hasSeparators: boolean;
    separatorType: string;
    numberPosition: 'prefix' | 'suffix' | 'middle' | 'none';
    likelyChapter: boolean;
  };
  confidence: number;
}


class AudiobookMCPServer {
  private server: Server;
  private learningData!: LearningData;
  private userPreferences!: Map<string, UserPreference>;
  private patternRecognizer!: PatternRecognizer;
  private suggestionEngine!: SmartSuggestionEngine;
  private webLookupEngine!: WebLookupEngine;
  private lookupCache!: LookupCache;

  constructor() {
    this.server = new Server(
      {
        name: 'audiobook-library',
        version: '1.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize learning system
    this.initializeLearningSystem();
    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    // List all tools available
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'scan_library',
            description: 'Recursively scan the audiobook library and return structure',
            inputSchema: {
              type: 'object',
              properties: {
                subfolder: {
                  type: 'string',
                  description: 'Subfolder to scan (audiobooks, Temp, or blank for root)',
                  default: 'audiobooks',
                },
                maxDepth: {
                  type: 'number',
                  description: 'Maximum directory depth to scan (default: 5)',
                  default: 5,
                },
                includeMetadata: {
                  type: 'boolean',
                  description: 'Extract metadata from audio files',
                  default: false,
                },
              },
            },
          },
          {
            name: 'intelligent_filename_analysis',
            description: 'Analyze filenames using web lookups to identify authors, titles, and series',
            inputSchema: {
              type: 'object',
              properties: {
                targetPath: {
                  type: 'string',
                  description: 'Specific file/directory path to analyze (or blank for recent files)',
                },
                lookupSources: {
                  type: 'array',
                  items: {
                    type: 'string',
                    enum: ['google_books', 'openlibrary', 'audible', 'goodreads', 'librivox', 'all']
                  },
                  description: 'Web sources to use for lookups',
                  default: ['google_books', 'openlibrary']
                },
                minConfidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Minimum confidence threshold for web lookup results',
                  default: 0.6,
                },
                maxResults: {
                  type: 'number',
                  description: 'Maximum number of files to analyze',
                  default: 20,
                },
              },
            },
          },
          {
            name: 'smart_entity_recognition',
            description: 'Identify authors, titles, series from filenames using pattern matching and web lookups',
            inputSchema: {
              type: 'object',
              properties: {
                filenames: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of filenames to analyze',
                },
                contextPath: {
                  type: 'string',
                  description: 'Directory context for additional clues',
                },
                enableWebLookup: {
                  type: 'boolean',
                  description: 'Enable web lookups for unknown entities',
                  default: true,
                },
                aggressiveMatching: {
                  type: 'boolean',
                  description: 'Use more aggressive pattern matching',
                  default: false,
                },
              },
              required: ['filenames'],
            },
          },
          {
            name: 'web_lookup_book',
            description: 'Perform web lookups for specific book information',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query for book information',
                },
                queryType: {
                  type: 'string',
                  enum: ['title', 'author', 'series', 'isbn', 'mixed'],
                  description: 'Type of query being performed',
                  default: 'mixed',
                },
                sources: {
                  type: 'array',
                  items: {
                    type: 'string',
                    enum: ['google_books', 'openlibrary', 'audible', 'goodreads']
                  },
                  description: 'Web sources to query',
                  default: ['google_books', 'openlibrary']
                },
                useCache: {
                  type: 'boolean',
                  description: 'Use cached results if available',
                  default: true,
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'enhance_metadata_with_lookup',
            description: 'Enhance existing metadata using web lookup results',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'Path to audio file to enhance',
                },
                forceRefresh: {
                  type: 'boolean',
                  description: 'Force fresh web lookups even if metadata exists',
                  default: false,
                },
                mergingStrategy: {
                  type: 'string',
                  enum: ['prefer_existing', 'prefer_lookup', 'merge_all', 'highest_confidence'],
                  description: 'How to merge existing and lookup metadata',
                  default: 'merge_all',
                },
              },
              required: ['filePath'],
            },
          },
          {
            name: 'bulk_filename_enrichment',
            description: 'Bulk analyze and suggest improvements for multiple files using web lookups',
            inputSchema: {
              type: 'object',
              properties: {
                targetDirectory: {
                  type: 'string',
                  description: 'Directory to analyze (or blank for Temp folder)',
                },
                includeSubdirectories: {
                  type: 'boolean',
                  description: 'Include files in subdirectories',
                  default: true,
                },
                fileTypes: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'File extensions to include',
                  default: ['.mp3', '.m4a', '.m4b', '.flac'],
                },
                batchSize: {
                  type: 'number',
                  description: 'Number of files to process in each batch',
                  default: 10,
                },
                generateSuggestions: {
                  type: 'boolean',
                  description: 'Generate renaming/organization suggestions',
                  default: true,
                },
              },
            },
          },
          {
            name: 'analyze_patterns',
            description: 'Analyze library patterns and user behavior to provide intelligent suggestions',
            inputSchema: {
              type: 'object',
              properties: {
                analysisType: {
                  type: 'string',
                  enum: ['naming_patterns', 'organization_patterns', 'user_preferences', 'all'],
                  description: 'Type of pattern analysis to perform',
                  default: 'all',
                },
                learningDepth: {
                  type: 'string',
                  enum: ['basic', 'intermediate', 'advanced'],
                  description: 'Depth of pattern analysis',
                  default: 'intermediate',
                },
                includePredictions: {
                  type: 'boolean',
                  description: 'Include predictive suggestions based on learned patterns',
                  default: true,
                },
              },
            },
          },
          {
            name: 'smart_suggestions',
            description: 'Generate intelligent suggestions based on learned patterns and user preferences',
            inputSchema: {
              type: 'object',
              properties: {
                targetPath: {
                  type: 'string',
                  description: 'Specific path to analyze (or blank for entire library)',
                },
                suggestionTypes: {
                  type: 'array',
                  items: {
                    type: 'string',
                    enum: ['naming', 'organization', 'metadata', 'conversion', 'series_detection']
                  },
                  description: 'Types of suggestions to generate',
                  default: ['naming', 'organization', 'metadata']
                },
                minConfidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Minimum confidence threshold for suggestions',
                  default: 0.7,
                },
                maxSuggestions: {
                  type: 'number',
                  description: 'Maximum number of suggestions to return',
                  default: 10,
                },
              },
            },
          },
          {
            name: 'learn_from_action',
            description: 'Record and learn from user actions to improve future suggestions',
            inputSchema: {
              type: 'object',
              properties: {
                actionType: {
                  type: 'string',
                  enum: ['rename', 'move', 'organize', 'convert', 'metadata_edit', 'structure_change'],
                  description: 'Type of action performed',
                },
                context: {
                  type: 'object',
                  properties: {
                    originalPath: { type: 'string' },
                    newPath: { type: 'string' },
                    metadata: { type: 'object' },
                    reasoning: { type: 'string' },
                  },
                  required: ['originalPath'],
                  description: 'Context information about the action',
                },
                outcome: {
                  type: 'string',
                  enum: ['accepted', 'rejected', 'modified'],
                  description: 'How the user responded to the suggestion',
                },
                feedback: {
                  type: 'string',
                  description: 'Optional user feedback about the action',
                },
              },
              required: ['actionType', 'context', 'outcome'],
            },
          },
          {
            name: 'update_preferences',
            description: 'Update user preferences based on explicit input or learned behavior',
            inputSchema: {
              type: 'object',
              properties: {
                preferences: {
                  type: 'object',
                  properties: {
                    namingStyle: {
                      type: 'string',
                      enum: ['author_first', 'series_first', 'hybrid'],
                      description: 'Preferred naming convention',
                    },
                    organizationStyle: {
                      type: 'string',
                      enum: ['author_based', 'series_based', 'genre_based', 'hybrid'],
                      description: 'Preferred organization structure',
                    },
                    metadataPreferences: {
                      type: 'object',
                      properties: {
                        prioritizeMetadata: { type: 'boolean' },
                        requireNarrator: { type: 'boolean' },
                        requireSeries: { type: 'boolean' },
                        preferredBitrate: { type: 'string' },
                      },
                      description: 'Metadata handling preferences',
                    },
                    qualityPreferences: {
                      type: 'object',
                      properties: {
                        preferM4B: { type: 'boolean' },
                        defaultBitrate: { type: 'string' },
                        chapterMarkers: { type: 'boolean' },
                      },
                      description: 'Audio quality preferences',
                    },
                  },
                  description: 'User preferences to update',
                },
                learningMode: {
                  type: 'string',
                  enum: ['explicit', 'adaptive', 'conservative'],
                  description: 'How aggressively to learn and adapt',
                  default: 'adaptive',
                },
              },
              required: ['preferences'],
            },
          },
          {
            name: 'pattern_insights',
            description: 'Get insights about detected patterns and learning progress',
            inputSchema: {
              type: 'object',
              properties: {
                insightType: {
                  type: 'string',
                  enum: ['summary', 'patterns', 'preferences', 'suggestions_performance', 'learning_stats'],
                  description: 'Type of insights to retrieve',
                  default: 'summary',
                },
                timeframe: {
                  type: 'string',
                  enum: ['week', 'month', 'quarter', 'year', 'all'],
                  description: 'Timeframe for analysis',
                  default: 'month',
                },
              },
            },
          },
          {
            name: 'get_file_info',
            description: 'Get detailed information about a specific file or directory',
            inputSchema: {
              type: 'object',
              properties: {
                relativePath: {
                  type: 'string',
                  description: 'Path relative to audiobook root',
                },
                includeMetadata: {
                  type: 'boolean',
                  description: 'Extract audio metadata if file is an audiobook',
                  default: true,
                },
              },
              required: ['relativePath'],
            },
          },
          {
            name: 'rename_file',
            description: 'Rename a file or directory',
            inputSchema: {
              type: 'object',
              properties: {
                oldPath: {
                  type: 'string',
                  description: 'Current path relative to audiobook root',
                },
                newPath: {
                  type: 'string',
                  description: 'New path relative to audiobook root',
                },
                dryRun: {
                  type: 'boolean',
                  description: 'Preview the operation without executing',
                  default: true,
                },
              },
              required: ['oldPath', 'newPath'],
            },
          },
          {
            name: 'create_directory',
            description: 'Create a new directory structure',
            inputSchema: {
              type: 'object',
              properties: {
                relativePath: {
                  type: 'string',
                  description: 'Directory path to create, relative to audiobook root',
                },
              },
              required: ['relativePath'],
            },
          },
          {
            name: 'move_file',
            description: 'Move a file or directory to a new location',
            inputSchema: {
              type: 'object',
              properties: {
                sourcePath: {
                  type: 'string',
                  description: 'Source path relative to audiobook root',
                },
                destinationPath: {
                  type: 'string',
                  description: 'Destination path relative to audiobook root',
                },
                dryRun: {
                  type: 'boolean',
                  description: 'Preview the operation without executing',
                  default: true,
                },
              },
              required: ['sourcePath', 'destinationPath'],
            },
          },
          {
            name: 'extract_archive',
            description: 'Extract compressed audio book archives',
            inputSchema: {
              type: 'object',
              properties: {
                archivePath: {
                  type: 'string',
                  description: 'Path to archive file relative to audiobook root',
                },
                extractTo: {
                  type: 'string',
                  description: 'Directory to extract to (optional, defaults to archive location)',
                },
                deleteAfter: {
                  type: 'boolean',
                  description: 'Delete archive after successful extraction',
                  default: false,
                },
                dryRun: {
                  type: 'boolean',
                  description: 'Preview the operation without executing',
                  default: true,
                },
              },
              required: ['archivePath'],
            },
          },
          {
            name: 'validate_naming_rules',
            description: 'Check if files follow Audiobookshelf naming conventions',
            inputSchema: {
              type: 'object',
              properties: {
                relativePath: {
                  type: 'string',
                  description: 'Path to validate, relative to audiobook root',
                },
              },
              required: ['relativePath'],
            },
          },
          {
            name: 'suggest_reorganization',
            description: 'Analyze current structure and suggest improvements',
            inputSchema: {
              type: 'object',
              properties: {
                targetStructure: {
                  type: 'string',
                  enum: ['series-first', 'author-first', 'hybrid'],
                  description: 'Preferred organization structure',
                  default: 'hybrid',
                },
              },
            },
          },
          {
            name: 'integrate_temp_folder',
            description: 'Analyze Temp folder and suggest integration into main audiobooks library',
            inputSchema: {
              type: 'object',
              properties: {
                dryRun: {
                  type: 'boolean',
                  description: 'Preview the operations without executing',
                  default: true,
                },
              },
            },
          },
          {
            name: 'standardize_audiobookshelf_structure',
            description: 'Convert current structure to Audiobookshelf naming standards',
            inputSchema: {
              type: 'object',
              properties: {
                targetPath: {
                  type: 'string',
                  description: 'Specific path to standardize (or blank for entire library)',
                },
                convention: {
                  type: 'string',
                  enum: ['author-first', 'series-first', 'auto-detect'],
                  description: 'Preferred naming convention',
                  default: 'auto-detect',
                },
                includeMetadata: {
                  type: 'boolean',
                  description: 'Use extracted metadata for standardization',
                  default: true,
                },
                dryRun: {
                  type: 'boolean',
                  description: 'Preview the operations without executing',
                  default: true,
                },
              },
            },
          },
          {
            name: 'validate_audiobookshelf_compliance',
            description: 'Check if library structure follows Audiobookshelf best practices',
            inputSchema: {
              type: 'object',
              properties: {
                targetPath: {
                  type: 'string',
                  description: 'Specific path to validate (or blank for entire library)',
                },
                strictMode: {
                  type: 'boolean',
                  description: 'Apply strict Audiobookshelf validation rules',
                  default: false,
                },
              },
            },
          },
          {
            name: 'generate_audiobookshelf_structure',
            description: 'Generate optimal Audiobookshelf directory structure from metadata',
            inputSchema: {
              type: 'object',
              properties: {
                basedOn: {
                  type: 'string',
                  enum: ['metadata', 'filenames', 'hybrid'],
                  description: 'Source for structure generation',
                  default: 'hybrid',
                },
                convention: {
                  type: 'string',
                  enum: ['author-first', 'series-first', 'hybrid'],
                  description: 'Preferred organization structure',
                  default: 'hybrid',
                },
                includeSeriesNumbers: {
                  type: 'boolean',
                  description: 'Include series numbers in directory names',
                  default: true,
                },
              },
            },
          },
          {
            name: 'combine_mp3_files',
            description: 'Combine multiple MP3 files into a single MP3 file',
            inputSchema: {
              type: 'object',
              properties: {
                inputFiles: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of MP3 file paths relative to audiobook root',
                },
                outputPath: {
                  type: 'string',
                  description: 'Output file path relative to audiobook root',
                },
                deleteOriginals: {
                  type: 'boolean',
                  description: 'Delete original files after successful combination',
                  default: false,
                },
                dryRun: {
                  type: 'boolean',
                  description: 'Preview the operation without executing',
                  default: true,
                },
              },
              required: ['inputFiles', 'outputPath'],
            },
          },
          {
            name: 'create_m4b_audiobook',
            description: 'Convert and combine audio files into M4B audiobook format with metadata',
            inputSchema: {
              type: 'object',
              properties: {
                inputFiles: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Array of audio file paths relative to audiobook root',
                },
                outputPath: {
                  type: 'string',
                  description: 'Output M4B file path relative to audiobook root',
                },
                metadata: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: 'Book title' },
                    author: { type: 'string', description: 'Author name' },
                    narrator: { type: 'string', description: 'Narrator name' },
                    series: { type: 'string', description: 'Series name' },
                    seriesNumber: { type: 'number', description: 'Book number in series' },
                    genre: { type: 'string', description: 'Genre' },
                    publisher: { type: 'string', description: 'Publisher' },
                    releaseDate: { type: 'string', description: 'Release date (YYYY-MM-DD)' },
                    description: { type: 'string', description: 'Book description' },
                    language: { type: 'string', description: 'Language code (e.g., en, es)' },
                    isbn: { type: 'string', description: 'ISBN number' },
                  },
                  description: 'Metadata to embed in the M4B file',
                },
                createChapters: {
                  type: 'boolean',
                  description: 'Create chapter markers from individual files',
                  default: true,
                },
                bitrate: {
                  type: 'string',
                  enum: ['64k', '96k', '128k', '160k', '192k', '256k'],
                  description: 'Audio bitrate for output file',
                  default: '128k',
                },
                deleteOriginals: {
                  type: 'boolean',
                  description: 'Delete original files after successful conversion',
                  default: false,
                },
                dryRun: {
                  type: 'boolean',
                  description: 'Preview the operation without executing',
                  default: true,
                },
              },
              required: ['inputFiles', 'outputPath'],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'scan_library':
            return await this.scanLibrary(request.params.arguments);
          case 'get_file_info':
            return await this.getFileInfo(request.params.arguments);
          case 'rename_file':
            return await this.renameFile(request.params.arguments);
          case 'create_directory':
            return await this.createDirectory(request.params.arguments);
          case 'move_file':
            return await this.moveFile(request.params.arguments);
          case 'extract_archive':
            return await this.extractArchive(request.params.arguments);
          case 'validate_naming_rules':
            return await this.validateNamingRules(request.params.arguments);
          case 'suggest_reorganization':
            return await this.suggestReorganization(request.params.arguments);
          case 'integrate_temp_folder':
            return await this.integrateTempFolder(request.params.arguments);
          case 'standardize_audiobookshelf_structure':
            return await this.standardizeAudiobookshelfStructure(request.params.arguments);
          case 'validate_audiobookshelf_compliance':
            return await this.validateAudiobookshelfCompliance(request.params.arguments);
          case 'generate_audiobookshelf_structure':
            return await this.generateAudiobookshelfStructure(request.params.arguments);
          case 'combine_mp3_files':
            return await this.combineMp3Files(request.params.arguments);
          case 'create_m4b_audiobook':
            return await this.createM4bAudiobook(request.params.arguments);
          case 'analyze_patterns':
            return await this.analyzePatterns(request.params.arguments);
          case 'smart_suggestions':
            return await this.generateSmartSuggestions(request.params.arguments);
          case 'learn_from_action':
            return await this.learnFromAction(request.params.arguments);
          case 'update_preferences':
            return await this.updateUserPreferences(request.params.arguments);
          case 'pattern_insights':
            return await this.getPatternInsights(request.params.arguments);
          case 'intelligent_filename_analysis':
            return await this.performIntelligentFilenameAnalysis(request.params.arguments);
          case 'smart_entity_recognition':
            return await this.performSmartEntityRecognition(request.params.arguments);
          case 'web_lookup_book':
            return await this.performWebLookup(request.params.arguments);
          case 'enhance_metadata_with_lookup':
            return await this.enhanceMetadataWithLookup(request.params.arguments);
          case 'bulk_filename_enrichment':
            return await this.performBulkFilenameEnrichment(request.params.arguments);
          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    });
  }

  // Learning System Initialization
  private async initializeLearningSystem() {
    // Initialize learning data
    this.learningData = await this.loadLearningData();
    
    // Initialize user preferences
    this.userPreferences = await this.loadUserPreferences();
    
    // Initialize lookup cache
    this.lookupCache = await this.loadLookupCache();
    
    // Initialize web lookup engine
    this.webLookupEngine = new WebLookupEngine(this.lookupCache);
    
    // Initialize pattern recognizer
    this.patternRecognizer = new PatternRecognizer(this.learningData);
    
    // Initialize suggestion engine
    this.suggestionEngine = new SmartSuggestionEngine(
      this.learningData,
      this.userPreferences,
      this.patternRecognizer
    );
    
    console.log('🧠 Enhanced learning system initialized with', {
      totalActions: this.learningData.userActions.length,
      detectedPatterns: this.learningData.detectedPatterns.length,
      userPreferences: this.userPreferences.size,
      cachedLookups: Object.keys(this.lookupCache).length
    });
  }

  private async loadLearningData(): Promise<LearningData> {
    try {
      const data = await fs.readFile(LEARNING_DATA_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      // Validate and migrate data if needed
      return this.migrateLearningData(parsed);
    } catch (error) {
      // Create default learning data structure
      return {
        version: '1.0.0',
        userActions: [],
        detectedPatterns: [],
        suggestions: [],
        statistics: {
          totalActions: 0,
          acceptanceRate: 0,
          commonPatterns: [],
          preferredStructures: []
        }
      };
    }
  }

  private async loadUserPreferences(): Promise<Map<string, UserPreference>> {
    try {
      const data = await fs.readFile(USER_PREFERENCES_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      const preferences = new Map<string, UserPreference>();
      for (const [key, value] of Object.entries(parsed)) {
        preferences.set(key, value as UserPreference);
      }
      
      return preferences;
    } catch (error) {
      // Create default preferences
      return new Map<string, UserPreference>();
    }
  }

  private async loadLookupCache(): Promise<LookupCache> {
    try {
      const data = await fs.readFile(LOOKUP_CACHE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      // Clean expired entries
      const now = Date.now();
      const cleaned: LookupCache = {};
      
      for (const [key, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object' && 'expiresAt' in entry && (entry as any).expiresAt > now) {
          cleaned[key] = entry as any;
        }
      }
      
      return cleaned;
    } catch (error) {
      // Create default cache
      return {};
    }
  }

  private migrateLearningData(data: any): LearningData {
    // Handle version migrations here
    if (!data.version || data.version < '1.0.0') {
      // Perform migration logic
      data.version = '1.0.0';
    }
    
    return data;
  }

  private async saveLearningData() {
    try {
      await fs.writeFile(LEARNING_DATA_FILE, JSON.stringify(this.learningData, null, 2));
    } catch (error) {
      console.error('Failed to save learning data:', error);
    }
  }

  private async saveUserPreferences() {
    try {
      const prefsObj = Object.fromEntries(this.userPreferences);
      await fs.writeFile(USER_PREFERENCES_FILE, JSON.stringify(prefsObj, null, 2));
    } catch (error) {
      console.error('Failed to save user preferences:', error);
    }
  }

  private async saveLookupCache() {
    try {
      await fs.writeFile(LOOKUP_CACHE_FILE, JSON.stringify(this.lookupCache, null, 2));
    } catch (error) {
      console.error('Failed to save lookup cache:', error);
    }
  }

  // Learning System Methods
  private async analyzePatterns(args: any) {
    const analysisType = args?.analysisType || 'all';
    const learningDepth = args?.learningDepth || 'intermediate';
    const includePredictions = args?.includePredictions ?? true;

    try {
      const results: any = {
        analysisType,
        learningDepth,
        timestamp: Date.now(),
        insights: {}
      };

      if (analysisType === 'all' || analysisType === 'naming_patterns') {
        results.insights.namingPatterns = await this.analyzeNamingPatterns(learningDepth);
      }

      if (analysisType === 'all' || analysisType === 'organization_patterns') {
        results.insights.organizationPatterns = await this.analyzeOrganizationPatterns(learningDepth);
      }

      if (analysisType === 'all' || analysisType === 'user_preferences') {
        results.insights.userPreferences = await this.analyzeUserPreferences();
      }

      if (includePredictions) {
        results.predictions = await this.generatePredictiveInsights();
      }

      // Update pattern confidence based on analysis
      await this.updatePatternConfidence(results);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(results, null, 2)
        }]
      };

    } catch (error) {
      throw new Error(`Failed to analyze patterns: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async generateSmartSuggestions(args: any) {
    const targetPath = args?.targetPath || '';
    const suggestionTypes = args?.suggestionTypes || ['naming', 'organization', 'metadata'];
    const minConfidence = args?.minConfidence || 0.7;
    const maxSuggestions = args?.maxSuggestions || 10;

    try {
      // Get files to analyze
      let filesToAnalyze: FileInfo[];
      if (targetPath) {
        const fileInfo = await this.getFileInfo({ relativePath: targetPath, includeMetadata: true });
        const fileData = JSON.parse(fileInfo.content[0].text);
        filesToAnalyze = [fileData];
      } else {
        const scanResult = await this.scanLibrary({ maxDepth: 3, includeMetadata: true });
        const scanData = JSON.parse(scanResult.content[0].text);
        filesToAnalyze = scanData.files;
      }

      // Generate suggestions using the smart engine
      const suggestions = await this.suggestionEngine.generateSuggestions(
        filesToAnalyze,
        suggestionTypes,
        minConfidence,
        maxSuggestions
      );

      // Record suggestions for learning
      for (const suggestion of suggestions) {
        this.recordSuggestion(suggestion);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            targetPath: targetPath || 'entire library',
            suggestionTypes,
            minConfidence,
            totalSuggestions: suggestions.length,
            suggestions: suggestions.map((s: SmartSuggestion) => ({
              id: s.id,
              type: s.type,
              description: s.description,
              confidence: s.confidence,
              reasoning: s.reasoning,
              patterns: s.patterns,
              action: s.action
            }))
          }, null, 2)
        }]
      };

    } catch (error) {
      throw new Error(`Failed to generate smart suggestions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async learnFromAction(args: any) {
    const actionType = args.actionType;
    const context = args.context;
    const outcome = args.outcome;
    const feedback = args.feedback;

    try {
      // Create user action record
      const userAction: UserAction = {
        id: this.generateId(),
        timestamp: Date.now(),
        actionType,
        context,
        outcome,
        userFeedback: feedback
      };

      // Add to learning data
      this.learningData.userActions.push(userAction);
      this.learningData.statistics.totalActions++;

      // Update acceptance rate
      const acceptedActions = this.learningData.userActions.filter(a => a.outcome === 'accepted').length;
      this.learningData.statistics.acceptanceRate = acceptedActions / this.learningData.userActions.length;

      // Learn patterns from this action
      await this.patternRecognizer.learnFromAction(userAction);

      // Update user preferences based on action
      await this.updatePreferencesFromAction(userAction);

      // Save learning data
      await this.saveLearningData();
      await this.saveUserPreferences();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'learned',
            actionId: userAction.id,
            newPatterns: this.patternRecognizer.getRecentPatterns(),
            updatedPreferences: Array.from(this.userPreferences.keys()),
            learningStats: {
              totalActions: this.learningData.statistics.totalActions,
              acceptanceRate: Math.round(this.learningData.statistics.acceptanceRate * 100) / 100
            }
          }, null, 2)
        }]
      };

    } catch (error) {
      throw new Error(`Failed to learn from action: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async updateUserPreferences(args: any) {
    const preferences = args.preferences;
    const learningMode = args.learningMode || 'adaptive';

    try {
      const updated = [];
      const timestamp = Date.now();

      // Process each preference category
      for (const [category, prefs] of Object.entries(preferences)) {
        if (typeof prefs === 'object' && prefs !== null) {
          for (const [key, value] of Object.entries(prefs)) {
            const prefKey = `${category}.${key}`;
            
            const userPref: UserPreference = {
              category,
              preference: String(value),
              strength: learningMode === 'conservative' ? 0.5 : 0.8,
              adaptability: learningMode === 'explicit' ? 0.3 : 0.7,
              lastUpdated: timestamp,
              examples: []
            };

            this.userPreferences.set(prefKey, userPref);
            updated.push(prefKey);
          }
        }
      }

      // Save preferences
      await this.saveUserPreferences();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'updated',
            learningMode,
            updatedPreferences: updated,
            totalPreferences: this.userPreferences.size,
            preferences: Object.fromEntries(this.userPreferences)
          }, null, 2)
        }]
      };

    } catch (error) {
      throw new Error(`Failed to update preferences: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getPatternInsights(args: any) {
    const insightType = args?.insightType || 'summary';
    const timeframe = args?.timeframe || 'month';

    try {
      const insights: any = {
        insightType,
        timeframe,
        timestamp: Date.now()
      };

      const timeframeDays = this.getTimeframeDays(timeframe);
      const cutoffTime = Date.now() - (timeframeDays * 24 * 60 * 60 * 1000);

      switch (insightType) {
        case 'summary':
          insights.data = await this.generateInsightsSummary(cutoffTime);
          break;
        case 'patterns':
          insights.data = await this.getDetailedPatterns(cutoffTime);
          break;
        case 'preferences':
          insights.data = await this.getPreferencesInsights(cutoffTime);
          break;
        case 'suggestions_performance':
          insights.data = await this.getSuggestionsPerformance(cutoffTime);
          break;
        case 'learning_stats':
          insights.data = await this.getLearningStatistics(cutoffTime);
          break;
        default:
          throw new Error(`Unknown insight type: ${insightType}`);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(insights, null, 2)
        }]
      };

    } catch (error) {
      throw new Error(`Failed to get pattern insights: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async scanLibrary(args: any) {
    const subfolder = args?.subfolder || 'audiobooks';
    const maxDepth = args?.maxDepth || 5;
    const includeMetadata = args?.includeMetadata || false;

    // Determine scan root based on subfolder
    const scanRoot = subfolder ? path.join(AUDIOBOOK_ROOT, subfolder) : AUDIOBOOK_ROOT;

    const scanDirectory = async (dirPath: string, depth: number): Promise<FileInfo[]> => {
      if (depth > maxDepth) return [];

      const items: FileInfo[] = [];
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
          // Skip hidden files and system files
          if (entry.name.startsWith('.') || entry.name === 'Thumbs.db') continue;

          const fullPath = path.join(dirPath, entry.name);
          const relativePath = path.relative(scanRoot, fullPath);
          
          const fileInfo: FileInfo = {
            path: relativePath,
            name: entry.name,
            size: 0,
            isDirectory: entry.isDirectory(),
          };

          if (!entry.isDirectory()) {
            try {
              const stats = await fs.stat(fullPath);
              fileInfo.size = stats.size;
              fileInfo.extension = path.extname(entry.name).toLowerCase();

              if (includeMetadata && SUPPORTED_AUDIO_FORMATS.includes(fileInfo.extension || '')) {
                fileInfo.metadata = await this.extractMetadata(fullPath);
              }
            } catch (error) {
              console.error(`Error reading file ${fullPath}:`, error);
            }
          }

          items.push(fileInfo);

          if (entry.isDirectory()) {
            items.push(...await scanDirectory(fullPath, depth + 1));
          }
        }
      } catch (error) {
        console.error(`Error reading directory ${dirPath}:`, error);
      }

      return items;
    };

    try {
      const files = await scanDirectory(scanRoot, 0);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rootPath: scanRoot,
              subfolder: subfolder,
              totalFiles: files.length,
              audioFiles: files.filter(f => f.extension && SUPPORTED_AUDIO_FORMATS.includes(f.extension)).length,
              archiveFiles: files.filter(f => f.extension && SUPPORTED_ARCHIVE_FORMATS.includes(f.extension)).length,
              directories: files.filter(f => f.isDirectory).length,
              files: files,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to scan library: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getFileInfo(args: any) {
    const fullPath = path.join(AUDIOBOOK_ROOT, args.relativePath);
    
    try {
      const stats = await fs.stat(fullPath);
      const info: FileInfo = {
        path: args.relativePath,
        name: path.basename(fullPath),
        size: stats.size,
        isDirectory: stats.isDirectory(),
      };

      if (!stats.isDirectory()) {
        info.extension = path.extname(info.name).toLowerCase();
        
        if (args.includeMetadata && SUPPORTED_AUDIO_FORMATS.includes(info.extension || '')) {
          info.metadata = await this.extractMetadata(fullPath);
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`File not found: ${args.relativePath}`);
    }
  }

  private async renameFile(args: any) {
    const oldFullPath = path.join(AUDIOBOOK_ROOT, args.oldPath);
    const newFullPath = path.join(AUDIOBOOK_ROOT, args.newPath);

    // Security check - ensure paths are within audiobook root
    if (!oldFullPath.startsWith(AUDIOBOOK_ROOT) || !newFullPath.startsWith(AUDIOBOOK_ROOT)) {
      throw new Error('Paths must be within audiobook root directory');
    }

    if (args.dryRun) {
      return {
        content: [
          {
            type: 'text',
            text: `DRY RUN: Would rename "${args.oldPath}" to "${args.newPath}"`,
          },
        ],
      };
    }

    await fs.rename(oldFullPath, newFullPath);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully renamed "${args.oldPath}" to "${args.newPath}"`,
        },
      ],
    };
  }

  private async createDirectory(args: any) {
    const fullPath = path.join(AUDIOBOOK_ROOT, args.relativePath);
    
    // Security check
    if (!fullPath.startsWith(AUDIOBOOK_ROOT)) {
      throw new Error('Path must be within audiobook root directory');
    }
    
    await fs.mkdir(fullPath, { recursive: true });
    
    return {
      content: [
        {
          type: 'text',
          text: `Created directory: ${args.relativePath}`,
        },
      ],
    };
  }

  private async moveFile(args: any) {
    const sourceFullPath = path.join(AUDIOBOOK_ROOT, args.sourcePath);
    const destFullPath = path.join(AUDIOBOOK_ROOT, args.destinationPath);

    // Security checks
    if (!sourceFullPath.startsWith(AUDIOBOOK_ROOT) || !destFullPath.startsWith(AUDIOBOOK_ROOT)) {
      throw new Error('Paths must be within audiobook root directory');
    }

    if (args.dryRun) {
      return {
        content: [
          {
            type: 'text',
            text: `DRY RUN: Would move "${args.sourcePath}" to "${args.destinationPath}"`,
          },
        ],
      };
    }

    // Create destination directory if it doesn't exist
    await fs.mkdir(path.dirname(destFullPath), { recursive: true });
    await fs.rename(sourceFullPath, destFullPath);
    
    return {
      content: [
        {
          type: 'text',
          text: `Successfully moved "${args.sourcePath}" to "${args.destinationPath}"`,
        },
      ],
    };
  }

  private async extractArchive(args: any) {
    const archiveFullPath = path.join(AUDIOBOOK_ROOT, args.archivePath);
    const extractPath = args.extractTo 
      ? path.join(AUDIOBOOK_ROOT, args.extractTo)
      : path.dirname(archiveFullPath);

    // Security checks
    if (!archiveFullPath.startsWith(AUDIOBOOK_ROOT) || !extractPath.startsWith(AUDIOBOOK_ROOT)) {
      throw new Error('Paths must be within audiobook root directory');
    }

    if (args.dryRun) {
      return {
        content: [
          {
            type: 'text',
            text: `DRY RUN: Would extract "${args.archivePath}" to "${path.relative(AUDIOBOOK_ROOT, extractPath)}"`,
          },
        ],
      };
    }

    const extension = path.extname(args.archivePath).toLowerCase();
    let command: string;

    switch (extension) {
      case '.zip':
        command = `unzip -q "${archiveFullPath}" -d "${extractPath}"`;
        break;
      case '.rar':
        // Try different extraction methods
        command = `ditto -xk "${archiveFullPath}" "${extractPath}"`;
        break;
      case '.7z':
        command = `ditto -xk "${archiveFullPath}" "${extractPath}"`;
        break;
      default:
        throw new Error(`Unsupported archive format: ${extension}`);
    }

    try {
      await execAsync(command);
    } catch (error) {
      throw new Error(`Failed to extract archive: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (args.deleteAfter) {
      await fs.unlink(archiveFullPath);
    }

    return {
      content: [
        {
          type: 'text',
          text: `Successfully extracted "${args.archivePath}"${args.deleteAfter ? ' and deleted archive' : ''}`,
        },
      ],
    };
  }

  private async validateNamingRules(args: any) {
    const fullPath = path.join(AUDIOBOOK_ROOT, args.relativePath);
    
    try {
      const stats = await fs.stat(fullPath);
      const issues: string[] = [];
      const suggestions: string[] = [];

      const filename = path.basename(fullPath);
      
      // Basic validation rules
      if (filename.includes('  ')) {
        issues.push('Contains double spaces');
        suggestions.push('Replace double spaces with single spaces');
      }
      
      if (/[<>:"|?*]/.test(filename)) {
        issues.push('Contains invalid characters for cross-platform compatibility');
        suggestions.push('Remove or replace characters: < > : " | ? *');
      }
      
      if (filename.length > 255) {
        issues.push('Filename too long (over 255 characters)');
        suggestions.push('Shorten filename');
      }

      // Series numbering validation
      const seriesMatch = filename.match(/(\d+)/);
      if (seriesMatch && !seriesMatch[1].padStart(2, '0')) {
        issues.push('Series number not zero-padded');
        suggestions.push('Use format: 01, 02, 03 instead of 1, 2, 3');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              path: args.relativePath,
              isValid: issues.length === 0,
              issues,
              suggestions,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Cannot validate path: ${args.relativePath}`);
    }
  }

  private async suggestReorganization(args: any) {
    try {
      const scanResult = await this.scanLibrary({ maxDepth: 3, includeMetadata: false });
      const scanData = JSON.parse(scanResult.content[0].text);
      
      const suggestions: any[] = [];
      const directories = scanData.files.filter((f: FileInfo) => f.isDirectory);
      
      // Analyze directory structure and suggest improvements
      for (const dir of directories) {
        const dirName = dir.name;
        
        // Detect series patterns
        if (/\d+/.test(dirName) && dirName.includes(' - ')) {
          suggestions.push({
            type: 'series_organization',
            current: dir.path,
            suggestion: `Move to Series folder structure`,
            reason: 'Detected numbered series'
          });
        }
        
        // Detect author name patterns
        if (dirName.includes(',') || /^[A-Z][a-z]+ [A-Z]/.test(dirName)) {
          suggestions.push({
            type: 'author_organization',
            current: dir.path,
            suggestion: `Organize under Authors/${dirName}`,
            reason: 'Detected author name pattern'
          });
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              targetStructure: args.targetStructure || 'hybrid',
              totalDirectories: directories.length,
              suggestions,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to analyze library: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async integrateTempFolder(args: any) {
    try {
      const tempPath = path.join(AUDIOBOOK_ROOT, 'Temp');
      const audioPath = path.join(AUDIOBOOK_ROOT, 'audiobooks');
      
      // Scan Temp folder
      const tempScan = await this.scanLibrary({ subfolder: 'Temp', maxDepth: 3 });
      const tempData = JSON.parse(tempScan.content[0].text);
      
      const integrationPlan: any[] = [];
      
      for (const file of tempData.files) {
        if (file.isDirectory) {
          // Analyze directory name to determine destination
          const dirName = file.name;
          let suggestion = '';
          
          // Check for author patterns
          if (dirName.includes(',') || /^[A-Z][a-z]+ [A-Z]/.test(dirName)) {
            suggestion = `Authors/${dirName}`;
          }
          // Check for series patterns
          else if (/\d+/.test(dirName) && (dirName.includes(' - ') || dirName.includes(': '))) {
            const seriesName = dirName.split(/\d+/)[0].trim().replace(' -', '').replace(':', '');
            suggestion = `Series/${seriesName}/${dirName}`;
          }
          // Default to Authors
          else {
            suggestion = `Authors/${dirName}`;
          }
          
          integrationPlan.push({
            source: `Temp/${file.path}`,
            destination: suggestion,
            type: 'directory_move',
            reason: 'Detected pattern-based organization'
          });
        }
      }
      
      if (args.dryRun) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                tempItems: tempData.files.length,
                integrationPlan,
                note: 'This is a dry run - no files were moved'
              }, null, 2),
            },
          ],
        };
      }
      
      // Execute integration plan
      const results = [];
      for (const plan of integrationPlan) {
        try {
          const sourcePath = path.join(AUDIOBOOK_ROOT, plan.source);
          const destPath = path.join(audioPath, plan.destination);
          
          // Create destination directory
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          
          // Move the file/directory
          await fs.rename(sourcePath, destPath);
          
          results.push({
            ...plan,
            status: 'success'
          });
        } catch (error) {
          results.push({
            ...plan,
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              totalOperations: integrationPlan.length,
              successful: results.filter(r => r.status === 'success').length,
              failed: results.filter(r => r.status === 'error').length,
              results
            }, null, 2),
          },
        ],
      };
      
    } catch (error) {
      throw new Error(`Failed to integrate temp folder: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async standardizeAudiobookshelfStructure(args: any) {
    const targetPath = args?.targetPath || '';
    const convention = args?.convention || 'auto-detect';
    const includeMetadata = args?.includeMetadata ?? true;
    const dryRun = args?.dryRun ?? true;

    try {
      // Determine scope - specific path or entire library
      const scanPath = targetPath ? path.join(AUDIOBOOK_ROOT, targetPath) : AUDIOBOOK_ROOT;
      
      // Scan the target area
      const scanResult = await this.scanLibrary({ 
        subfolder: targetPath || 'audiobooks', 
        maxDepth: 5, 
        includeMetadata 
      });
      const scanData = JSON.parse(scanResult.content[0].text);
      
      const standardizationPlan: any[] = [];
      const audioFiles = scanData.files.filter((f: FileInfo) => 
        f.extension && SUPPORTED_AUDIO_FORMATS.includes(f.extension)
      );
      
      for (const file of audioFiles) {
        const currentPath = file.path;
        const fullPath = path.join(scanData.rootPath, currentPath);
        
        // Get metadata for this file
        let metadata: AudiobookMetadata;
        if (includeMetadata && file.metadata) {
          metadata = file.metadata;
        } else {
          metadata = await this.extractMetadata(fullPath);
        }
        
        // Generate standardized path
        const standardizedPath = await this.generateStandardPath(metadata, convention, currentPath);
        
        if (standardizedPath.path !== currentPath) {
          standardizationPlan.push({
            currentPath,
            recommendedPath: standardizedPath.path,
            reason: standardizedPath.reason,
            confidence: standardizedPath.confidence,
            metadata: {
              title: metadata.title,
              author: metadata.author,
              series: metadata.series,
              seriesNumber: metadata.seriesNumber
            }
          });
        }
      }
      
      if (dryRun) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              targetPath: targetPath || 'entire library',
              convention,
              totalFiles: audioFiles.length,
              filesToStandardize: standardizationPlan.length,
              standardizationPlan,
              note: 'This is a dry run - no files were moved'
            }, null, 2)
          }]
        };
      }
      
      // Execute standardization
      const results = [];
      for (const plan of standardizationPlan) {
        try {
          const sourcePath = path.join(scanData.rootPath, plan.currentPath);
          const destPath = path.join(AUDIOBOOK_ROOT, 'audiobooks', plan.recommendedPath);
          
          // Create destination directory
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          
          // Move the file
          await fs.rename(sourcePath, destPath);
          
          results.push({
            ...plan,
            status: 'success'
          });
        } catch (error) {
          results.push({
            ...plan,
            status: 'error',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            totalOperations: standardizationPlan.length,
            successful: results.filter(r => r.status === 'success').length,
            failed: results.filter(r => r.status === 'error').length,
            results
          }, null, 2)
        }]
      };
      
    } catch (error) {
      throw new Error(`Failed to standardize structure: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async validateAudiobookshelfCompliance(args: any) {
    const targetPath = args?.targetPath || '';
    const strictMode = args?.strictMode ?? false;
    
    try {
      // Scan the target area
      const scanResult = await this.scanLibrary({ 
        subfolder: targetPath || 'audiobooks', 
        maxDepth: 5, 
        includeMetadata: false 
      });
      const scanData = JSON.parse(scanResult.content[0].text);
      
      const validationResults: any[] = [];
      const issues: string[] = [];
      const suggestions: string[] = [];
      
      // Validate directory structure
      const directories = scanData.files.filter((f: FileInfo) => f.isDirectory);
      const audioFiles = scanData.files.filter((f: FileInfo) => 
        f.extension && SUPPORTED_AUDIO_FORMATS.includes(f.extension)
      );
      
      // Check for proper top-level organization
      const topLevelDirs = directories.filter((d: FileInfo) => !d.path.includes('/'));
      const hasAuthorStructure = topLevelDirs.some((d: FileInfo) => d.name === 'Authors');
      const hasSeriesStructure = topLevelDirs.some((d: FileInfo) => d.name === 'Series');
      
      if (!hasAuthorStructure && !hasSeriesStructure) {
        issues.push('No standard top-level organization (Authors/ or Series/)');
        suggestions.push('Create Authors/ or Series/ top-level directories');
      }
      
      // Validate each audio file
      for (const file of audioFiles) {
        const validation = this.validateSinglePath(file.path, strictMode);
        if (!validation.isValid) {
          validationResults.push({
            path: file.path,
            ...validation
          });
        }
      }
      
      // Calculate overall compliance score
      const totalFiles = audioFiles.length;
      const compliantFiles = totalFiles - validationResults.length;
      const complianceScore = totalFiles > 0 ? (compliantFiles / totalFiles) * 100 : 100;
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            targetPath: targetPath || 'entire library',
            strictMode,
            complianceScore: Math.round(complianceScore * 10) / 10,
            totalFiles,
            compliantFiles,
            nonCompliantFiles: validationResults.length,
            overallIssues: issues,
            overallSuggestions: suggestions,
            fileValidations: validationResults
          }, null, 2)
        }]
      };
      
    } catch (error) {
      throw new Error(`Failed to validate compliance: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async generateAudiobookshelfStructure(args: any) {
    const basedOn = args?.basedOn || 'hybrid';
    const convention = args?.convention || 'hybrid';
    const includeSeriesNumbers = args?.includeSeriesNumbers ?? true;
    
    try {
      // Scan library with metadata
      const scanResult = await this.scanLibrary({ 
        maxDepth: 5, 
        includeMetadata: true 
      });
      const scanData = JSON.parse(scanResult.content[0].text);
      
      const audioFiles = scanData.files.filter((f: FileInfo) => 
        f.extension && SUPPORTED_AUDIO_FORMATS.includes(f.extension)
      );
      
      const structureMap = new Map<string, any>();
      const seriesMap = new Map<string, any>();
      const authorMap = new Map<string, any>();
      
      // Analyze all files to build optimal structure
      for (const file of audioFiles) {
        const fullPath = path.join(scanData.rootPath, file.path);
        const metadata = file.metadata || await this.extractMetadata(fullPath);
        
        const author = this.sanitizeForFilename(metadata.author || 'Unknown Author');
        const series = metadata.series ? this.sanitizeForFilename(metadata.series) : null;
        const title = this.sanitizeForFilename(metadata.title || path.basename(file.name, path.extname(file.name)));
        const seriesNumber = metadata.seriesNumber;
        
        // Track series information
        if (series) {
          if (!seriesMap.has(series)) {
            seriesMap.set(series, {
              name: series,
              author,
              books: [],
              totalBooks: 0
            });
          }
          const seriesInfo = seriesMap.get(series);
          seriesInfo.books.push({ title, number: seriesNumber, file: file.path });
          seriesInfo.totalBooks++;
        }
        
        // Track author information
        if (!authorMap.has(author)) {
          authorMap.set(author, {
            name: author,
            series: new Set(),
            standaloneBooks: [],
            totalBooks: 0
          });
        }
        const authorInfo = authorMap.get(author);
        if (series) {
          authorInfo.series.add(series);
        } else {
          authorInfo.standaloneBooks.push({ title, file: file.path });
        }
        authorInfo.totalBooks++;
      }
      
      // Generate optimal structure based on analysis
      const structureRecommendations = this.generateOptimalStructure(
        authorMap, 
        seriesMap, 
        convention, 
        includeSeriesNumbers
      );
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            basedOn,
            convention,
            includeSeriesNumbers,
            analysis: {
              totalAuthors: authorMap.size,
              totalSeries: seriesMap.size,
              totalFiles: audioFiles.length,
              averageBooksPerAuthor: Math.round((audioFiles.length / authorMap.size) * 10) / 10,
              seriesDistribution: Array.from(seriesMap.values()).map(s => ({
                name: s.name,
                author: s.author,
                bookCount: s.totalBooks
              }))
            },
            recommendedStructure: structureRecommendations
          }, null, 2)
        }]
      };
      
    } catch (error) {
      throw new Error(`Failed to generate structure: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async combineMp3Files(args: any) {
    const inputFiles = args.inputFiles as string[];
    const outputPath = args.outputPath as string;
    const deleteOriginals = args.deleteOriginals ?? false;
    const dryRun = args.dryRun ?? true;

    // Validate input files
    const fullInputPaths = inputFiles.map(file => path.join(AUDIOBOOK_ROOT, file));
    const fullOutputPath = path.join(AUDIOBOOK_ROOT, outputPath);

    // Security checks
    if (!fullOutputPath.startsWith(AUDIOBOOK_ROOT)) {
      throw new Error('Output path must be within audiobook root directory');
    }

    for (const inputPath of fullInputPaths) {
      if (!inputPath.startsWith(AUDIOBOOK_ROOT)) {
        throw new Error('All input paths must be within audiobook root directory');
      }
    }

    // Verify all input files exist and are MP3s
    const fileInfos = [];
    for (const inputPath of fullInputPaths) {
      try {
        const stats = await fs.stat(inputPath);
        if (stats.isDirectory()) {
          throw new Error(`${path.relative(AUDIOBOOK_ROOT, inputPath)} is a directory, not a file`);
        }
        if (!inputPath.toLowerCase().endsWith('.mp3')) {
          throw new Error(`${path.relative(AUDIOBOOK_ROOT, inputPath)} is not an MP3 file`);
        }
        fileInfos.push({
          path: inputPath,
          size: stats.size,
          name: path.basename(inputPath)
        });
      } catch (error) {
        throw new Error(`Cannot access file ${path.relative(AUDIOBOOK_ROOT, inputPath)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (dryRun) {
      const totalSize = fileInfos.reduce((sum, file) => sum + file.size, 0);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            operation: 'combine_mp3_files',
            mode: 'DRY RUN',
            inputFiles: fileInfos.map(f => ({
              name: f.name,
              size: f.size,
              path: path.relative(AUDIOBOOK_ROOT, f.path)
            })),
            outputPath,
            estimatedOutputSize: totalSize,
            deleteOriginals,
            note: 'This is a preview - no files will be modified'
          }, null, 2)
        }]
      };
    }

    try {
      // Ensure output directory exists
      await fs.mkdir(path.dirname(fullOutputPath), { recursive: true });
      
      // Ensure temp directory exists
      await fs.mkdir(TEMP_DIR, { recursive: true });

      // Create file list for FFmpeg concat
      const fileListPath = path.join(TEMP_DIR, `filelist_${Date.now()}.txt`);
      const fileListContent = fullInputPaths
        .map(file => `file '${file.replace(/'/g, "'\\''")}` + "'")
        .join('\n');
      
      await fs.writeFile(fileListPath, fileListContent);

      // Use FFmpeg to combine MP3 files
      const ffmpegCommand = [
        'ffmpeg',
        '-f concat',
        '-safe 0',
        `-i "${fileListPath}"`,
        '-c copy',
        `-y "${fullOutputPath}"`
      ].join(' ');

      console.log('Executing FFmpeg command:', ffmpegCommand);
      await execAsync(ffmpegCommand);

      // Clean up temp file list
      await fs.unlink(fileListPath);

      // Get output file stats
      const outputStats = await fs.stat(fullOutputPath);

      // Delete original files if requested
      const deletedFiles = [];
      if (deleteOriginals) {
        for (const inputPath of fullInputPaths) {
          try {
            await fs.unlink(inputPath);
            deletedFiles.push(path.relative(AUDIOBOOK_ROOT, inputPath));
          } catch (error) {
            console.warn(`Failed to delete ${inputPath}:`, error);
          }
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            operation: 'combine_mp3_files',
            status: 'success',
            inputFiles: inputFiles,
            outputPath,
            outputSize: outputStats.size,
            deletedFiles: deleteOriginals ? deletedFiles : [],
            message: `Successfully combined ${inputFiles.length} MP3 files into ${outputPath}`
          }, null, 2)
        }]
      };

    } catch (error) {
      throw new Error(`Failed to combine MP3 files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createM4bAudiobook(args: any) {
    const inputFiles = args.inputFiles as string[];
    const outputPath = args.outputPath as string;
    const metadata = args.metadata || {};
    const createChapters = args.createChapters ?? true;
    const bitrate = args.bitrate || '128k';
    const deleteOriginals = args.deleteOriginals ?? false;
    const dryRun = args.dryRun ?? true;

    // Validate input files
    const fullInputPaths = inputFiles.map(file => path.join(AUDIOBOOK_ROOT, file));
    const fullOutputPath = path.join(AUDIOBOOK_ROOT, outputPath);

    // Ensure output has .m4b extension
    if (!fullOutputPath.toLowerCase().endsWith('.m4b')) {
      throw new Error('Output file must have .m4b extension');
    }

    // Security checks
    if (!fullOutputPath.startsWith(AUDIOBOOK_ROOT)) {
      throw new Error('Output path must be within audiobook root directory');
    }

    for (const inputPath of fullInputPaths) {
      if (!inputPath.startsWith(AUDIOBOOK_ROOT)) {
        throw new Error('All input paths must be within audiobook root directory');
      }
    }

    // Verify all input files exist and are audio files
    const fileInfos = [];
    let totalDuration = 0;
    
    for (const inputPath of fullInputPaths) {
      try {
        const stats = await fs.stat(inputPath);
        if (stats.isDirectory()) {
          throw new Error(`${path.relative(AUDIOBOOK_ROOT, inputPath)} is a directory, not a file`);
        }
        
        const ext = path.extname(inputPath).toLowerCase();
        if (!SUPPORTED_AUDIO_FORMATS.includes(ext)) {
          throw new Error(`${path.relative(AUDIOBOOK_ROOT, inputPath)} is not a supported audio format`);
        }
        
        // Get audio duration for chapter calculation
        let duration = 0;
        try {
          const audioMetadata = await parseFile(inputPath);
          duration = audioMetadata.format.duration || 0;
          totalDuration += duration;
        } catch (metaError) {
          console.warn(`Could not get duration for ${inputPath}:`, metaError);
        }
        
        fileInfos.push({
          path: inputPath,
          size: stats.size,
          name: path.basename(inputPath),
          duration
        });
      } catch (error) {
        throw new Error(`Cannot access file ${path.relative(AUDIOBOOK_ROOT, inputPath)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (dryRun) {
      const totalSize = fileInfos.reduce((sum, file) => sum + file.size, 0);
      
      // Generate chapter information preview
      const chapters = createChapters ? this.generateChapterInfo(fileInfos) : [];
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            operation: 'create_m4b_audiobook',
            mode: 'DRY RUN',
            inputFiles: fileInfos.map(f => ({
              name: f.name,
              size: f.size,
              duration: f.duration,
              path: path.relative(AUDIOBOOK_ROOT, f.path)
            })),
            outputPath,
            estimatedOutputSize: Math.round(totalSize * 0.7), // Rough estimate after compression
            totalDuration: Math.round(totalDuration),
            metadata,
            chapters: chapters.slice(0, 5), // Show first 5 chapters as preview
            totalChapters: chapters.length,
            bitrate,
            deleteOriginals,
            note: 'This is a preview - no files will be modified'
          }, null, 2)
        }]
      };
    }

    try {
      // Ensure output directory exists
      await fs.mkdir(path.dirname(fullOutputPath), { recursive: true });
      
      // Ensure temp directory exists
      await fs.mkdir(TEMP_DIR, { recursive: true });

      // Create file list for FFmpeg concat
      const fileListPath = path.join(TEMP_DIR, `m4b_filelist_${Date.now()}.txt`);
      const fileListContent = fullInputPaths
        .map(file => `file '${file.replace(/'/g, "'\\''")}` + "'")
        .join('\n');
      
      await fs.writeFile(fileListPath, fileListContent);

      // Build FFmpeg command with metadata and chapters
      const ffmpegArgs = [
        'ffmpeg',
        '-f concat',
        '-safe 0',
        `-i "${fileListPath}"`,
        `-c:a aac`,
        `-b:a ${bitrate}`,
        '-movflags +faststart'
      ];

      // Add metadata
      if (metadata.title) ffmpegArgs.push(`-metadata title="${this.escapeFFmpegMetadata(metadata.title)}"`);
      if (metadata.author) ffmpegArgs.push(`-metadata artist="${this.escapeFFmpegMetadata(metadata.author)}"`);
      if (metadata.author) ffmpegArgs.push(`-metadata album_artist="${this.escapeFFmpegMetadata(metadata.author)}"`);
      if (metadata.series) ffmpegArgs.push(`-metadata album="${this.escapeFFmpegMetadata(metadata.series)}"`);
      if (metadata.genre) ffmpegArgs.push(`-metadata genre="${this.escapeFFmpegMetadata(metadata.genre)}"`);
      if (metadata.releaseDate) ffmpegArgs.push(`-metadata date="${this.escapeFFmpegMetadata(metadata.releaseDate)}"`);
      if (metadata.publisher) ffmpegArgs.push(`-metadata publisher="${this.escapeFFmpegMetadata(metadata.publisher)}"`);
      if (metadata.description) ffmpegArgs.push(`-metadata description="${this.escapeFFmpegMetadata(metadata.description)}"`);
      if (metadata.language) ffmpegArgs.push(`-metadata language="${this.escapeFFmpegMetadata(metadata.language)}"`);
      if (metadata.narrator) ffmpegArgs.push(`-metadata composer="${this.escapeFFmpegMetadata(metadata.narrator)}"`);
      if (metadata.seriesNumber) ffmpegArgs.push(`-metadata track="${metadata.seriesNumber}"`);
      if (metadata.isbn) ffmpegArgs.push(`-metadata comment="ISBN: ${this.escapeFFmpegMetadata(metadata.isbn)}"`);

      // Add chapter information if requested
      if (createChapters && fileInfos.length > 1) {
        const chapterFile = await this.createChapterFile(fileInfos);
        ffmpegArgs.push(`-i "${chapterFile}"`);
        ffmpegArgs.push('-map_metadata 1');
      }

      ffmpegArgs.push('-y');
      ffmpegArgs.push(`"${fullOutputPath}"`);

      const ffmpegCommand = ffmpegArgs.join(' ');
      console.log('Executing FFmpeg command:', ffmpegCommand);
      
      await execAsync(ffmpegCommand);

      // Clean up temp files
      await fs.unlink(fileListPath);
      
      // Get output file stats
      const outputStats = await fs.stat(fullOutputPath);

      // Delete original files if requested
      const deletedFiles = [];
      if (deleteOriginals) {
        for (const inputPath of fullInputPaths) {
          try {
            await fs.unlink(inputPath);
            deletedFiles.push(path.relative(AUDIOBOOK_ROOT, inputPath));
          } catch (error) {
            console.warn(`Failed to delete ${inputPath}:`, error);
          }
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            operation: 'create_m4b_audiobook',
            status: 'success',
            inputFiles: inputFiles,
            outputPath,
            outputSize: outputStats.size,
            totalDuration: Math.round(totalDuration),
            metadata,
            chaptersCreated: createChapters && fileInfos.length > 1,
            bitrate,
            deletedFiles: deleteOriginals ? deletedFiles : [],
            message: `Successfully created M4B audiobook from ${inputFiles.length} files: ${outputPath}`
          }, null, 2)
        }]
      };

    } catch (error) {
      throw new Error(`Failed to create M4B audiobook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async extractMetadata(filePath: string): Promise<AudiobookMetadata> {
    try {
      // Try to extract from audio file metadata first
      const audioMetadata = await this.extractAudioMetadata(filePath);
      if (audioMetadata.confidence > 0.7) {
        return audioMetadata;
      }

      // Fallback to filename/directory parsing
      const filenameMetadata = this.parseFromFilename(filePath);
      
      // Combine and return best available metadata
      return this.combineMetadata(audioMetadata, filenameMetadata);
    } catch (error) {
      console.error(`Error extracting metadata from ${filePath}:`, error);
      return this.parseFromFilename(filePath);
    }
  }

  private async extractAudioMetadata(filePath: string): Promise<AudiobookMetadata> {
    try {
      const metadata: IAudioMetadata = await parseFile(filePath);
      const common = metadata.common;
      
      const result: AudiobookMetadata = {
        title: common.title || undefined,
        author: this.extractAuthor(common),
        narrator: this.extractNarrator(common),
        series: this.extractSeriesFromTags(common),
        seriesNumber: this.extractSeriesNumber(common),
        duration: metadata.format.duration,
        genre: common.genre?.[0] || undefined,
        publisher: common.label?.[0] || undefined,
        releaseDate: common.date || undefined,
        description: typeof common.comment?.[0] === 'string' ? common.comment[0] : undefined,
        language: common.language || undefined,
        confidence: this.calculateMetadataConfidence(common),
        source: 'metadata'
      };

      return result;
    } catch (error) {
      return {
        confidence: 0,
        source: 'metadata'
      };
    }
  }

  private extractAuthor(common: ICommonTagsResult): string | undefined {
    // Try multiple fields where author might be stored
    return common.artist || 
           common.albumartist || 
           common.composer?.[0] || 
           this.parseAuthorFromAlbum(common.album);
  }

  private extractNarrator(common: ICommonTagsResult): string | undefined {
    // Narrator is often stored in comment, performer, or custom fields
    const comment = typeof common.comment?.[0] === 'string' ? common.comment[0] : '';
    
    // Look for patterns like "Narrated by John Doe" or "Read by Jane Smith"
    const narratorMatch = comment.match(/(?:narrated by|read by|narrator:)\s*([^,\n]+)/i);
    if (narratorMatch) {
      return narratorMatch[1].trim();
    }
    
    // Sometimes stored as performer - check if it exists in the interface
    // Note: performer might not exist in ICommonTagsResult, so we'll skip this
    return undefined;
  }

  private extractSeriesFromTags(common: ICommonTagsResult): string | undefined {
    // Series might be in album, grouping, or custom tags
    const album = common.album || '';
    const grouping = common.grouping?.[0] || '';
    
    // Look for series patterns in album field
    const seriesPattern = /^(.+?)\s*(?:book|#|vol\.?\s*\d+|series)/i;
    const albumMatch = album.match(seriesPattern);
    if (albumMatch) {
      return albumMatch[1].trim();
    }
    
    // Check grouping field
    if (grouping && !grouping.match(/^\d+$/)) {
      return grouping;
    }
    
    return undefined;
  }

  private extractSeriesNumber(common: ICommonTagsResult): number | undefined {
    // Try track number first
    if (common.track?.no && common.track.no > 0) {
      return common.track.no;
    }
    
    // Look in album field for numbers
    const album = common.album || '';
    const numberMatch = album.match(/(?:book|#|vol\.?\s*)(\d+)/i);
    if (numberMatch) {
      return parseInt(numberMatch[1]);
    }
    
    // Check title field
    const title = common.title || '';
    const titleMatch = title.match(/(?:book|#|vol\.?\s*)(\d+)/i);
    if (titleMatch) {
      return parseInt(titleMatch[1]);
    }
    
    return undefined;
  }

  private parseAuthorFromAlbum(album?: string): string | undefined {
    if (!album) return undefined;
    
    // Sometimes album contains "Author - Series" format
    const authorMatch = album.match(/^([^-]+)\s*-/);
    return authorMatch ? authorMatch[1].trim() : undefined;
  }

  private parseFromFilename(filePath: string): AudiobookMetadata {
    const filename = path.basename(filePath, path.extname(filePath));
    const dirPath = path.dirname(filePath);
    const dirNames = dirPath.split(path.sep).filter(Boolean);
    
    let confidence = 0.3; // Base confidence for filename parsing
    
    // Extract from directory structure
    let author: string | undefined;
    let series: string | undefined;
    let title = filename;
    
    // Common pattern: Authors/Author Name/Series/Book
    if (dirNames.length >= 2 && dirNames[dirNames.length - 3] === 'Authors') {
      author = dirNames[dirNames.length - 2];
      series = dirNames[dirNames.length - 1];
      confidence += 0.2;
    } else if (dirNames.length >= 1) {
      // Try to extract author from parent directory
      const parentDir = dirNames[dirNames.length - 1];
      if (this.looksLikeAuthorName(parentDir)) {
        author = parentDir;
        confidence += 0.1;
      }
    }
    
    // Parse filename for series number and title
    const { parsedTitle, seriesNumber } = this.parseFilenameComponents(filename);
    if (parsedTitle !== filename) {
      title = parsedTitle;
      confidence += 0.1;
    }
    
    return {
      title,
      author,
      series,
      seriesNumber,
      confidence,
      source: 'filename'
    };
  }

  private parseFilenameComponents(filename: string): { parsedTitle: string; seriesNumber?: number } {
    // Common patterns:
    // "01 - Title", "Book 1 - Title", "Series Name 01 - Title"
    
    const patterns = [
      /^(\d+)\s*[-–]\s*(.+)$/, // "01 - Title"
      /^(?:book|vol\.?)\s*(\d+)\s*[-–]\s*(.+)$/i, // "Book 1 - Title"
      /^(.+?)\s+(\d+)\s*[-–]\s*(.+)$/, // "Series 01 - Title"
      /^(.+?)\s*#(\d+)\s*[-–]?\s*(.*)$/, // "Series #1" or "Series #1 - Title"
    ];
    
    for (const pattern of patterns) {
      const match = filename.match(pattern);
      if (match) {
        if (match.length === 3) {
          // Pattern with just number and title
          return {
            parsedTitle: match[2].trim(),
            seriesNumber: parseInt(match[1])
          };
        } else if (match.length === 4) {
          // Pattern with series, number, and title
          return {
            parsedTitle: match[3].trim() || match[1].trim(),
            seriesNumber: parseInt(match[2])
          };
        }
      }
    }
    
    return { parsedTitle: filename };
  }

  private looksLikeAuthorName(name: string): boolean {
    // Simple heuristics to identify author names
    const authorPatterns = [
      /^[A-Z][a-z]+\s+[A-Z]/,  // "First Last" or "First Middle Last"
      /^[A-Z][a-z]+,\s*[A-Z]/,  // "Last, First"
      /^\w+\s+\w+$/,            // Two words (likely first/last name)
    ];
    
    return authorPatterns.some(pattern => pattern.test(name));
  }

  private calculateMetadataConfidence(common: ICommonTagsResult): number {
    let confidence = 0;
    
    // Award points for each available field
    if (common.title) confidence += 0.2;
    if (common.artist || common.albumartist) confidence += 0.2;
    if (common.album) confidence += 0.1;
    if (common.track?.no) confidence += 0.1;
    if (common.genre?.length) confidence += 0.1;
    if (common.date) confidence += 0.1;
    
    // Bonus for audiobook-specific indicators
    try {
      const firstComment = common.comment?.[0] as string | undefined;
      if (firstComment && firstComment.toLowerCase().includes('narrat')) {
        confidence += 0.1;
      }
    } catch {
      // Ignore comment processing errors
    }
    if (common.genre?.some(g => g.toLowerCase().includes('audiobook'))) confidence += 0.1;
    
    return Math.min(confidence, 1.0);
  }

  private combineMetadata(audioMetadata: AudiobookMetadata, filenameMetadata: AudiobookMetadata): AudiobookMetadata {
    const combined: AudiobookMetadata = {
      confidence: Math.max(audioMetadata.confidence, filenameMetadata.confidence),
      source: 'mixed'
    };
    
    // Prefer audio metadata when available and confident, fallback to filename
    combined.title = this.selectBestField(audioMetadata.title, filenameMetadata.title, audioMetadata.confidence, filenameMetadata.confidence);
    combined.author = this.selectBestField(audioMetadata.author, filenameMetadata.author, audioMetadata.confidence, filenameMetadata.confidence);
    combined.series = this.selectBestField(audioMetadata.series, filenameMetadata.series, audioMetadata.confidence, filenameMetadata.confidence);
    combined.seriesNumber = this.selectBestField(audioMetadata.seriesNumber, filenameMetadata.seriesNumber, audioMetadata.confidence, filenameMetadata.confidence);
    
    // Audio-only fields
    combined.narrator = audioMetadata.narrator;
    combined.duration = audioMetadata.duration;
    combined.genre = audioMetadata.genre;
    combined.publisher = audioMetadata.publisher;
    combined.releaseDate = audioMetadata.releaseDate;
    combined.description = audioMetadata.description;
    combined.language = audioMetadata.language;
    combined.isbn = audioMetadata.isbn;
    
    return combined;
  }

  private selectBestField<T>(audioValue: T, filenameValue: T, audioConfidence: number, filenameConfidence: number): T {
    if (audioValue && audioConfidence >= filenameConfidence) {
      return audioValue;
    }
    return filenameValue || audioValue;
  }

  // Audiobookshelf-specific helper methods
  private async generateStandardPath(metadata: AudiobookMetadata, convention: string, currentPath: string): Promise<{path: string, reason: string, confidence: number}> {
    const author = this.sanitizeForFilename(metadata.author || 'Unknown Author');
    const series = metadata.series ? this.sanitizeForFilename(metadata.series) : null;
    const title = this.sanitizeForFilename(metadata.title || path.basename(currentPath, path.extname(currentPath)));
    const seriesNumber = metadata.seriesNumber;
    
    let standardPath: string;
    let reason: string;
    let confidence = metadata.confidence;
    
    // Determine best convention if auto-detect
    if (convention === 'auto-detect') {
      convention = series ? 'author-first' : 'author-first'; // Default to author-first
    }
    
    if (convention === 'series-first' && series) {
      // Series-first: Series/Author/Book ## - Title
      const bookNumber = seriesNumber ? String(seriesNumber).padStart(2, '0') + ' - ' : '';
      standardPath = `Series/${series}/${author}/${bookNumber}${title}.${path.extname(currentPath).slice(1)}`;
      reason = 'Series-first organization with author subfolder';
    } else if (series) {
      // Author-first with series: Authors/Author/Series/Book ## - Title
      const bookNumber = seriesNumber ? String(seriesNumber).padStart(2, '0') + ' - ' : '';
      standardPath = `Authors/${author}/${series}/${bookNumber}${title}.${path.extname(currentPath).slice(1)}`;
      reason = 'Author-first organization with series';
    } else {
      // Standalone book: Authors/Author/Title
      standardPath = `Authors/${author}/${title}.${path.extname(currentPath).slice(1)}`;
      reason = 'Author-first organization for standalone book';
    }
    
    return {
      path: standardPath,
      reason,
      confidence
    };
  }
  
  private validateSinglePath(filePath: string, strictMode: boolean): AudiobookshelfStructure {
    const issues: string[] = [];
    const suggestions: string[] = [];
    let confidence = 1.0;
    
    const pathParts = filePath.split('/');
    const filename = pathParts[pathParts.length - 1];
    
    // Check filename for invalid characters
    if (AUDIOBOOKSHELF_PATTERNS.INVALID_CHARS.test(filename)) {
      issues.push('Contains invalid characters');
      suggestions.push('Remove or replace invalid characters: < > : " | ? * \\');
      confidence -= 0.3;
    }
    
    // Check filename length
    if (filename.length > AUDIOBOOKSHELF_PATTERNS.MAX_FILENAME_LENGTH) {
      issues.push('Filename too long');
      suggestions.push(`Shorten filename to under ${AUDIOBOOKSHELF_PATTERNS.MAX_FILENAME_LENGTH} characters`);
      confidence -= 0.2;
    }
    
    // Check path structure
    if (pathParts.length < 2) {
      issues.push('Files should be in subdirectories (Authors/Author/ or Series/Series/)');
      suggestions.push('Move files into proper directory structure');
      confidence -= 0.4;
    }
    
    // Check for proper top-level organization
    const topLevel = pathParts[0];
    if (!['Authors', 'Series'].includes(topLevel)) {
      issues.push('Should be organized under Authors/ or Series/');
      suggestions.push('Move to Authors/ or Series/ directory structure');
      confidence -= 0.3;
    }
    
    // Strict mode additional checks
    if (strictMode) {
      // Check for consistent numbering
      const numberMatch = filename.match(/(\d+)/); 
      if (numberMatch && !numberMatch[1].padStart(2, '0')) {
        issues.push('Series numbers should be zero-padded');
        suggestions.push('Use format: 01, 02, 03 instead of 1, 2, 3');
        confidence -= 0.1;
      }
      
      // Check for proper separators
      if (filename.includes('_') || filename.includes('..')) {
        issues.push('Use hyphens (-) as separators instead of underscores or multiple dots');
        suggestions.push('Replace underscores with hyphens');
        confidence -= 0.1;
      }
    }
    
    return {
      isValid: issues.length === 0,
      issues,
      suggestions,
      confidence: Math.max(confidence, 0)
    };
  }
  
  private sanitizeForFilename(input: string): string {
    return input
      .replace(AUDIOBOOKSHELF_PATTERNS.INVALID_CHARS, '') // Remove invalid chars
      .replace(/\s+/g, ' ') // Normalize spaces
      .replace(/^\s+|\s+$/g, '') // Trim
      .replace(/\.$/, ''); // Remove trailing dots
  }
  
  private generateOptimalStructure(authorMap: Map<string, any>, seriesMap: Map<string, any>, convention: string, includeSeriesNumbers: boolean): any {
    const recommendations: any[] = [];
    
    if (convention === 'author-first' || convention === 'hybrid') {
      // Author-first recommendations
      for (const [authorName, authorInfo] of authorMap) {
        const authorRec: any = {
          type: 'author',
          name: authorName,
          path: `Authors/${authorName}`,
          totalBooks: authorInfo.totalBooks,
          structure: []
        };
        
        // Add series under author
        for (const seriesName of authorInfo.series) {
          const seriesInfo = seriesMap.get(seriesName);
          if (seriesInfo) {
            authorRec.structure.push({
              type: 'series',
              name: seriesName,
              path: `Authors/${authorName}/${seriesName}`,
              bookCount: seriesInfo.totalBooks,
              books: seriesInfo.books.sort((a: any, b: any) => (a.number || 0) - (b.number || 0))
            });
          }
        }
        
        // Add standalone books
        if (authorInfo.standaloneBooks.length > 0) {
          authorRec.structure.push({
            type: 'standalone',
            books: authorInfo.standaloneBooks
          });
        }
        
        recommendations.push(authorRec);
      }
    }
    
    if (convention === 'series-first') {
      // Series-first recommendations
      for (const [seriesName, seriesInfo] of seriesMap) {
        recommendations.push({
          type: 'series',
          name: seriesName,
          path: `Series/${seriesName}`,
          author: seriesInfo.author,
          bookCount: seriesInfo.totalBooks,
          books: seriesInfo.books.sort((a: any, b: any) => (a.number || 0) - (b.number || 0))
        });
      }
    }
    
    return {
      convention,
      includeSeriesNumbers,
      structure: recommendations,
      summary: {
        totalStructures: recommendations.length,
        estimatedDirectories: this.calculateDirectoryCount(recommendations),
        organizationEfficiency: this.calculateOrganizationEfficiency(authorMap, seriesMap)
      }
    };
  }
  
  private calculateDirectoryCount(recommendations: any[]): number {
    let count = 0;
    for (const rec of recommendations) {
      count += 1; // Main directory
      if (rec.structure) {
        count += rec.structure.length; // Subdirectories
      }
    }
    return count;
  }
  
  private calculateOrganizationEfficiency(authorMap: Map<string, any>, seriesMap: Map<string, any>): number {
    // Calculate how well-organized the library is
    const totalBooks = Array.from(authorMap.values()).reduce((sum, author) => sum + author.totalBooks, 0);
    const seriesBooks = Array.from(seriesMap.values()).reduce((sum, series) => sum + series.totalBooks, 0);
    const seriesRatio = totalBooks > 0 ? seriesBooks / totalBooks : 0;
    
    // Higher efficiency for more series organization
    return Math.round(seriesRatio * 100);
  }

  // Helper methods for audio processing
  private generateChapterInfo(fileInfos: any[]): any[] {
    const chapters = [];
    let currentTime = 0;
    
    for (let i = 0; i < fileInfos.length; i++) {
      const file = fileInfos[i];
      const chapterTitle = this.extractChapterTitle(file.name);
      
      chapters.push({
        number: i + 1,
        title: chapterTitle,
        startTime: currentTime,
        endTime: currentTime + file.duration,
        duration: file.duration
      });
      
      currentTime += file.duration;
    }
    
    return chapters;
  }

  private extractChapterTitle(filename: string): string {
    // Remove file extension
    const nameWithoutExt = path.basename(filename, path.extname(filename));
    
    // Common patterns to clean up
    const patterns = [
      /^\d+\s*[-–]\s*(.+)$/, // "01 - Chapter Title"
      /^(?:chapter|ch\.?)\s*\d+\s*[-–]\s*(.+)$/i, // "Chapter 1 - Title"
      /^(.+?)\s*[-–]\s*(?:chapter|ch\.?)\s*\d+$/i, // "Title - Chapter 1"
    ];
    
    for (const pattern of patterns) {
      const match = nameWithoutExt.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }
    
    // If no pattern matches, return cleaned filename
    return nameWithoutExt.replace(/^\d+[.\s]*/, '').trim() || nameWithoutExt;
  }

  private async createChapterFile(fileInfos: any[]): Promise<string> {
    const chapters = this.generateChapterInfo(fileInfos);
    const chapterFilePath = path.join(TEMP_DIR, `chapters_${Date.now()}.txt`);
    
    // Create FFmpeg chapter metadata format
    let chapterContent = ';FFMETADATA1\n';
    
    for (const chapter of chapters) {
      const startTimeMs = Math.round(chapter.startTime * 1000);
      const endTimeMs = Math.round(chapter.endTime * 1000);
      
      chapterContent += `[CHAPTER]\n`;
      chapterContent += `TIMEBASE=1/1000\n`;
      chapterContent += `START=${startTimeMs}\n`;
      chapterContent += `END=${endTimeMs}\n`;
      chapterContent += `title=${this.escapeFFmpegMetadata(chapter.title)}\n\n`;
    }
    
    await fs.writeFile(chapterFilePath, chapterContent);
    return chapterFilePath;
  }

  private escapeFFmpegMetadata(text: string): string {
    // Escape special characters for FFmpeg metadata
    return text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'");
  }

  // Helper methods for learning system
  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }

  private getTimeframeDays(timeframe: string): number {
    switch (timeframe) {
      case 'week': return 7;
      case 'month': return 30;
      case 'quarter': return 90;
      case 'year': return 365;
      case 'all': return 9999;
      default: return 30;
    }
  }

  private recordSuggestion(suggestion: SmartSuggestion) {
    const record: SuggestionRecord = {
      id: suggestion.id,
      timestamp: Date.now(),
      type: suggestion.type,
      suggestion: suggestion.action,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
      accepted: false
    };
    
    this.learningData.suggestions.push(record);
  }

  // Placeholder methods for pattern analysis (implement based on your specific needs)
  private async analyzeNamingPatterns(depth: string): Promise<any> {
    // Analyze existing library structure for naming patterns
    const scanResult = await this.scanLibrary({ maxDepth: 3, includeMetadata: false });
    const scanData = JSON.parse(scanResult.content[0].text);
    
    const patterns = {
      authorFirst: 0,
      seriesFirst: 0,
      numbered: 0,
      confidence: 0.5,
      recommendations: []
    };
    
    // Analyze file/directory names for patterns
    for (const file of scanData.files) {
      if (file.isDirectory) {
        if (file.path.includes('Authors/')) patterns.authorFirst++;
        if (file.path.includes('Series/')) patterns.seriesFirst++;
        if (/\d+/.test(file.name)) patterns.numbered++;
      }
    }
    
    const total = scanData.files.filter((f: any) => f.isDirectory).length;
    if (total > 0) {
      patterns.confidence = Math.max(patterns.authorFirst, patterns.seriesFirst) / total;
    }
    
    return patterns;
  }

  private async analyzeOrganizationPatterns(depth: string): Promise<any> {
    // Implementation for analyzing organization patterns
    const patterns = {
      structures: {
        authorBased: 0,
        seriesBased: 0,
        genreBased: 0,
        hybrid: 0
      },
      depth: { average: 2, max: 5, min: 1 },
      confidence: 0.6
    };
    
    return patterns;
  }

  private async analyzeUserPreferences(): Promise<any> {
    const preferences = Array.from(this.userPreferences.entries()).map(([key, pref]) => ({
      key,
      category: pref.category,
      preference: pref.preference,
      strength: pref.strength,
      lastUpdated: pref.lastUpdated
    }));
    
    return {
      totalPreferences: preferences.length,
      categories: [...new Set(preferences.map(p => p.category))],
      preferences
    };
  }

  private async generatePredictiveInsights(): Promise<any> {
    return {
      likelyActions: ['organize_by_series', 'convert_to_m4b'],
      suggestedImprovements: ['standardize_naming', 'add_metadata'],
      confidence: 0.7
    };
  }

  private async updatePatternConfidence(results: any): Promise<void> {
    // Update pattern confidence based on analysis results
    // This would adjust the confidence scores of detected patterns
  }

  private async updatePreferencesFromAction(action: UserAction): Promise<void> {
    // Extract preferences from user actions
    if (action.outcome === 'accepted') {
      // Strengthen preferences that led to accepted suggestions
      const timestamp = Date.now();
      
      if (action.actionType === 'rename' && action.context.newPath) {
        // Learn naming preferences
        const namingPref: UserPreference = {
          category: 'naming',
          preference: this.extractNamingStyle(action.context.originalPath, action.context.newPath),
          strength: 0.1, // Small increment
          adaptability: 0.8,
          lastUpdated: timestamp,
          examples: [action.context.newPath]
        };
        
        const existing = this.userPreferences.get('naming.style');
        if (existing) {
          existing.strength = Math.min(1.0, existing.strength + 0.1);
          existing.lastUpdated = timestamp;
          existing.examples.push(action.context.newPath || '');
        } else {
          this.userPreferences.set('naming.style', namingPref);
        }
      }
    }
  }

  private extractNamingStyle(oldPath: string, newPath: string): string {
    if (newPath.includes('Authors/')) return 'author_first';
    if (newPath.includes('Series/')) return 'series_first';
    return 'hybrid';
  }

  private async generateInsightsSummary(cutoffTime: number): Promise<any> {
    const recentActions = this.learningData.userActions.filter(a => a.timestamp > cutoffTime);
    const recentPatterns = this.learningData.detectedPatterns.filter(p => p.lastSeen > cutoffTime);
    
    return {
      recentActivity: {
        totalActions: recentActions.length,
        acceptanceRate: recentActions.length > 0 ? 
          recentActions.filter(a => a.outcome === 'accepted').length / recentActions.length : 0,
        mostCommonAction: this.getMostCommonAction(recentActions)
      },
      patterns: {
        total: recentPatterns.length,
        highConfidence: recentPatterns.filter(p => p.confidence > 0.8).length,
        emerging: recentPatterns.filter(p => p.frequency < 3).length
      },
      recommendations: this.generateQuickRecommendations(recentActions, recentPatterns)
    };
  }

  private getMostCommonAction(actions: UserAction[]): string {
    const counts = actions.reduce((acc, action) => {
      acc[action.actionType] = (acc[action.actionType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    return Object.entries(counts).sort(([,a], [,b]) => b - a)[0]?.[0] || 'none';
  }

  private generateQuickRecommendations(actions: UserAction[], patterns: Pattern[]): string[] {
    const recommendations = [];
    
    if (actions.length > 10 && patterns.length < 3) {
      recommendations.push('Consider running pattern analysis to identify optimization opportunities');
    }
    
    const rejectedActions = actions.filter(a => a.outcome === 'rejected');
    if (rejectedActions.length > actions.length * 0.3) {
      recommendations.push('High rejection rate detected - consider adjusting suggestion confidence threshold');
    }
    
    return recommendations;
  }

  private async getDetailedPatterns(cutoffTime: number): Promise<any> {
    return this.learningData.detectedPatterns
      .filter(p => p.lastSeen > cutoffTime)
      .map(p => ({
        id: p.id,
        type: p.type,
        confidence: p.confidence,
        frequency: p.frequency,
        examples: p.examples.slice(0, 3)
      }));
  }

  private async getPreferencesInsights(cutoffTime: number): Promise<any> {
    const recentPrefs = Array.from(this.userPreferences.entries())
      .filter(([, pref]) => pref.lastUpdated > cutoffTime);
    
    return {
      recentlyUpdated: recentPrefs.length,
      strongPreferences: recentPrefs.filter(([, pref]) => pref.strength > 0.7).length,
      adaptablePreferences: recentPrefs.filter(([, pref]) => pref.adaptability > 0.7).length,
      preferences: recentPrefs.map(([key, pref]) => ({ key, ...pref }))
    };
  }

  private async getSuggestionsPerformance(cutoffTime: number): Promise<any> {
    const recentSuggestions = this.learningData.suggestions.filter(s => s.timestamp > cutoffTime);
    
    return {
      total: recentSuggestions.length,
      accepted: recentSuggestions.filter(s => s.accepted).length,
      averageConfidence: recentSuggestions.reduce((sum, s) => sum + s.confidence, 0) / recentSuggestions.length || 0,
      byType: this.groupSuggestionsByType(recentSuggestions)
    };
  }

  private groupSuggestionsByType(suggestions: SuggestionRecord[]): Record<string, number> {
    return suggestions.reduce((acc, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }

  private async getLearningStatistics(cutoffTime: number): Promise<any> {
    const recentActions = this.learningData.userActions.filter(a => a.timestamp > cutoffTime);
    
    return {
      learningVelocity: recentActions.length,
      patternDiscoveryRate: this.learningData.detectedPatterns.filter(p => p.lastSeen > cutoffTime).length,
      adaptationScore: this.calculateAdaptationScore(recentActions),
      confidence: this.learningData.statistics.acceptanceRate
    };
  }

  private calculateAdaptationScore(actions: UserAction[]): number {
    if (actions.length === 0) return 0;
    
    const accepted = actions.filter(a => a.outcome === 'accepted').length;
    const modified = actions.filter(a => a.outcome === 'modified').length;
    
    return (accepted + (modified * 0.5)) / actions.length;
  }

  // Missing method implementations (placeholders)
  private async performIntelligentFilenameAnalysis(args: any) {
    return {
      content: [
        {
          type: 'text',
          text: 'Intelligent filename analysis not yet implemented',
        },
      ],
    };
  }

  private async performSmartEntityRecognition(args: any) {
    return {
      content: [
        {
          type: 'text',
          text: 'Smart entity recognition not yet implemented',
        },
      ],
    };
  }

  private async performWebLookup(args: any) {
    return {
      content: [
        {
          type: 'text',
          text: 'Web lookup not yet implemented',
        },
      ],
    };
  }

  private async enhanceMetadataWithLookup(args: any) {
    return {
      content: [
        {
          type: 'text',
          text: 'Enhance metadata with lookup not yet implemented',
        },
      ],
    };
  }

  private async performBulkFilenameEnrichment(args: any) {
    return {
      content: [
        {
          type: 'text',
          text: 'Bulk filename enrichment not yet implemented',
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// Web Lookup Engine placeholder
class WebLookupEngine {
  constructor(private lookupCache: LookupCache) {}
}

// Pattern Recognition Engine
class PatternRecognizer {
  private learningData: LearningData;
  private recentPatterns: Pattern[] = [];

  constructor(learningData: LearningData) {
    this.learningData = learningData;
  }

  async learnFromAction(action: UserAction): Promise<void> {
    // Extract patterns from user actions
    const patterns = this.extractPatternsFromAction(action);
    
    for (const pattern of patterns) {
      await this.updateOrCreatePattern(pattern);
    }
  }

  private extractPatternsFromAction(action: UserAction): Partial<Pattern>[] {
    const patterns: Partial<Pattern>[] = [];
    const timestamp = Date.now();

    if (action.actionType === 'rename') {
      // Extract naming patterns
      const oldName = path.basename(action.context.originalPath);
      const newName = path.basename(action.context.newPath || '');
      
      if (this.detectNamingPattern(oldName, newName)) {
        patterns.push({
          type: 'naming',
          pattern: this.createNamingPattern(oldName, newName),
          confidence: 0.7,
          frequency: 1,
          lastSeen: timestamp,
          context: { actionType: action.actionType },
          examples: [newName]
        });
      }
    }

    if (action.actionType === 'move') {
      // Extract organization patterns
      const sourcePath = action.context.originalPath;
      const destPath = action.context.newPath || '';
      
      const orgPattern = this.detectOrganizationPattern(sourcePath, destPath);
      if (orgPattern) {
        patterns.push({
          type: 'organization',
          pattern: orgPattern,
          confidence: 0.8,
          frequency: 1,
          lastSeen: timestamp,
          context: { sourcePath, destPath },
          examples: [destPath]
        });
      }
    }

    return patterns;
  }

  private detectNamingPattern(oldName: string, newName: string): boolean {
    // Detect if there's a consistent naming transformation
    const oldParts = this.parseNameParts(oldName);
    const newParts = this.parseNameParts(newName);
    
    // Look for consistent patterns like adding numbers, changing separators, etc.
    return oldParts.base !== newParts.base || oldParts.separator !== newParts.separator;
  }

  private createNamingPattern(oldName: string, newName: string): string {
    const oldParts = this.parseNameParts(oldName);
    const newParts = this.parseNameParts(newName);
    
    if (newParts.number && !oldParts.number) {
      return 'add_numbering';
    }
    if (newParts.separator !== oldParts.separator) {
      return `change_separator_${oldParts.separator}_to_${newParts.separator}`;
    }
    return 'general_rename';
  }

  private parseNameParts(name: string): { base: string; number?: string; separator: string } {
    const numberMatch = name.match(/(\d+)/);
    const separatorMatch = name.match(/[-_\.\s]/);
    
    return {
      base: name.replace(/\d+/, '').replace(/[-_\.\s]+/g, ' ').trim(),
      number: numberMatch?.[1],
      separator: separatorMatch?.[0] || ' '
    };
  }

  private detectOrganizationPattern(sourcePath: string, destPath: string): string | null {
    const sourceDir = path.dirname(sourcePath);
    const destDir = path.dirname(destPath);
    
    if (destDir.includes('Authors/') && !sourceDir.includes('Authors/')) {
      return 'move_to_author_structure';
    }
    if (destDir.includes('Series/') && !sourceDir.includes('Series/')) {
      return 'move_to_series_structure';
    }
    if (destDir.split('/').length > sourceDir.split('/').length) {
      return 'organize_into_subdirectories';
    }
    
    return null;
  }

  private async updateOrCreatePattern(patternData: Partial<Pattern>): Promise<void> {
    const existingIndex = this.learningData.detectedPatterns.findIndex(
      p => p.type === patternData.type && p.pattern === patternData.pattern
    );

    if (existingIndex >= 0) {
      // Update existing pattern
      const existing = this.learningData.detectedPatterns[existingIndex];
      existing.frequency++;
      existing.lastSeen = Date.now();
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
      if (patternData.examples) {
        existing.examples.push(...patternData.examples);
        existing.examples = existing.examples.slice(-10); // Keep last 10 examples
      }
    } else {
      // Create new pattern
      const newPattern: Pattern = {
        id: this.generatePatternId(),
        type: patternData.type!,
        pattern: patternData.pattern!,
        confidence: patternData.confidence || 0.5,
        frequency: 1,
        lastSeen: Date.now(),
        context: patternData.context || {},
        examples: patternData.examples || []
      };
      
      this.learningData.detectedPatterns.push(newPattern);
      this.recentPatterns.push(newPattern);
    }
  }

  private generatePatternId(): string {
    return 'pat_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  getRecentPatterns(): Pattern[] {
    return this.recentPatterns.slice(-5); // Return last 5 patterns
  }
}

// Smart Suggestion Engine
class SmartSuggestionEngine {
  private learningData: LearningData;
  private userPreferences: Map<string, UserPreference>;
  private patternRecognizer: PatternRecognizer;

  constructor(
    learningData: LearningData,
    userPreferences: Map<string, UserPreference>,
    patternRecognizer: PatternRecognizer
  ) {
    this.learningData = learningData;
    this.userPreferences = userPreferences;
    this.patternRecognizer = patternRecognizer;
  }

  async generateSuggestions(
    files: FileInfo[],
    suggestionTypes: string[],
    minConfidence: number,
    maxSuggestions: number
  ): Promise<SmartSuggestion[]> {
    const suggestions: SmartSuggestion[] = [];

    for (const file of files) {
      if (suggestionTypes.includes('naming')) {
        suggestions.push(...await this.generateNamingSuggestions(file));
      }
      if (suggestionTypes.includes('organization')) {
        suggestions.push(...await this.generateOrganizationSuggestions(file));
      }
      if (suggestionTypes.includes('metadata')) {
        suggestions.push(...await this.generateMetadataSuggestions(file));
      }
      if (suggestionTypes.includes('conversion')) {
        suggestions.push(...await this.generateConversionSuggestions(file));
      }
    }

    // Filter by confidence and limit results
    return suggestions
      .filter(s => s.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxSuggestions);
  }

  private async generateNamingSuggestions(file: FileInfo): Promise<SmartSuggestion[]> {
    const suggestions: SmartSuggestion[] = [];
    
    // Check if filename follows learned patterns
    const namingPatterns = this.learningData.detectedPatterns.filter(p => p.type === 'naming');
    
    for (const pattern of namingPatterns) {
      if (pattern.confidence > 0.7) {
        const suggestion = this.createNamingSuggestion(file, pattern);
        if (suggestion) {
          suggestions.push(suggestion);
        }
      }
    }

    return suggestions;
  }

  private createNamingSuggestion(file: FileInfo, pattern: Pattern): SmartSuggestion | null {
    const currentName = file.name;
    
    if (pattern.pattern === 'add_numbering' && !/\d+/.test(currentName)) {
      return {
        id: this.generateSuggestionId(),
        type: 'rename',
        description: `Add numbering to "${currentName}" based on learned pattern`,
        action: {
          operation: 'rename',
          currentPath: file.path,
          suggestedName: this.addNumbering(currentName)
        },
        confidence: pattern.confidence * 0.9,
        reasoning: `Pattern "${pattern.pattern}" suggests adding numbering (used ${pattern.frequency} times)`,
        patterns: [pattern.id]
      };
    }

    return null;
  }

  private addNumbering(name: string): string {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    return `01 - ${base}${ext}`;
  }

  private async generateOrganizationSuggestions(file: FileInfo): Promise<SmartSuggestion[]> {
    const suggestions: SmartSuggestion[] = [];
    
    // Check user preferences for organization style
    const orgPref = this.userPreferences.get('organizationStyle');
    const namingPref = this.userPreferences.get('namingStyle');
    
    if (file.metadata) {
      const metadata = file.metadata;
      
      // Suggest organization based on metadata and preferences
      if (metadata.author && metadata.series) {
        const preferredStyle = orgPref?.preference || 'author_first';
        
        if (preferredStyle === 'author_first' || preferredStyle === 'hybrid') {
          suggestions.push({
            id: this.generateSuggestionId(),
            type: 'move',
            description: `Move to Authors/${metadata.author}/${metadata.series}/`,
            action: {
              operation: 'move',
              currentPath: file.path,
              suggestedPath: `Authors/${this.sanitizeFilename(metadata.author)}/${this.sanitizeFilename(metadata.series)}/`
            },
            confidence: 0.8 * (orgPref?.strength || 0.5),
            reasoning: 'Based on metadata and learned preferences for author-first organization',
            patterns: ['metadata_organization']
          });
        }
      }
    }

    return suggestions;
  }

  private async generateMetadataSuggestions(file: FileInfo): Promise<SmartSuggestion[]> {
    const suggestions: SmartSuggestion[] = [];
    
    if (file.extension && ['.mp3', '.m4a', '.flac'].includes(file.extension)) {
      // Suggest metadata improvements
      if (!file.metadata || file.metadata.confidence < 0.7) {
        suggestions.push({
          id: this.generateSuggestionId(),
          type: 'metadata',
          description: 'Enhance metadata for better organization',
          action: {
            operation: 'extract_metadata',
            filePath: file.path,
            enhanceFromFilename: true
          },
          confidence: 0.6,
          reasoning: 'Low metadata confidence detected',
          patterns: ['metadata_enhancement']
        });
      }
    }

    return suggestions;
  }

  private async generateConversionSuggestions(file: FileInfo): Promise<SmartSuggestion[]> {
    const suggestions: SmartSuggestion[] = [];
    
    // Check user preferences for M4B conversion
    const m4bPref = this.userPreferences.get('qualityPreferences.preferM4B');
    
    if (m4bPref?.preference === 'true' && file.extension === '.mp3') {
      suggestions.push({
        id: this.generateSuggestionId(),
        type: 'convert',
        description: 'Convert to M4B format based on preferences',
        action: {
          operation: 'convert_to_m4b',
          inputFile: file.path,
          outputFile: file.path.replace('.mp3', '.m4b')
        },
        confidence: m4bPref.strength,
        reasoning: 'User prefers M4B format for audiobooks',
        patterns: ['conversion_preference']
      });
    }

    return suggestions;
  }

  private sanitizeFilename(name: string): string {
    return name.replace(/[<>:"|?*\\]/g, '').replace(/\s+/g, ' ').trim();
  }

  private generateSuggestionId(): string {
    return 'sug_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }
}

// Start the server
const server = new AudiobookMCPServer();
server.run().catch(console.error);
