# Contributing to Audiobook MCP Server

Thank you for your interest in contributing! This project aims to create the most intelligent audiobook library management system possible.

## 🚀 Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/yourusername/audiobook-mcp-server.git`
3. Install dependencies: `npm install`
4. Build the project: `npm run build`
5. Create a feature branch: `git checkout -b feature/your-feature`

## 🎯 Areas for Contribution

### High Priority
- **Additional Web Sources**: Integrate more book databases (Goodreads, WorldCat, etc.)
- **Enhanced Pattern Recognition**: Improve filename parsing algorithms
- **Audio Format Support**: Add support for more audio formats
- **Performance Optimization**: Optimize web lookup caching and processing

### Medium Priority
- **UI Improvements**: Better error messages and user feedback
- **Testing**: Comprehensive test coverage for all components
- **Documentation**: Additional usage examples and tutorials
- **Internationalization**: Support for non-English book data

### Feature Ideas
- **Cover Art Download**: Automatically fetch and embed cover images
- **Series Auto-Detection**: Better series identification and numbering
- **Duplicate Detection**: Find and merge duplicate audiobooks
- **Playlist Generation**: Create listening playlists from series
- **Statistics Dashboard**: Analytics on library organization and usage

## 🛠️ Development Guidelines

### Code Style
- Use TypeScript for all new code
- Follow existing naming conventions
- Add JSDoc comments for public methods
- Use async/await for asynchronous operations

### Testing
```bash
# Run existing tests
npm test

# Add tests for new features
# Tests should go in __tests__/ directory
```

### Web API Integration
- Always implement caching for external API calls
- Add appropriate rate limiting
- Handle API errors gracefully
- Respect API terms of service

### Pattern Recognition
- New patterns should have confidence scoring
- Test with various filename formats
- Consider edge cases and special characters
- Document pattern examples in comments

## 📝 Pull Request Process

1. **Create an Issue**: Discuss major changes before implementation
2. **Write Tests**: Include tests for new functionality
3. **Update Documentation**: Update README if adding new features
4. **Test Thoroughly**: Ensure all existing functionality still works
5. **Create PR**: Include clear description of changes and motivation

### PR Template
```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Added tests for new functionality
- [ ] All existing tests pass
- [ ] Manually tested with various audiobook files

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No breaking changes (or clearly documented)
```

## 🐛 Bug Reports

When reporting bugs, please include:

- **System Information**: OS, Node.js version, FFmpeg version
- **Steps to Reproduce**: Clear steps to trigger the issue
- **Expected Behavior**: What should happen
- **Actual Behavior**: What actually happens
- **Sample Files**: Example filenames or file structures (anonymized)
- **Logs**: Any error messages or relevant log output

## 💡 Feature Requests

For feature requests, please provide:

- **Use Case**: Why is this feature needed?
- **Proposed Solution**: How should it work?
- **Alternatives Considered**: Other approaches you've thought about
- **Additional Context**: Any other relevant information

## 🎧 Testing with Audiobook Files

### Test Data Guidelines
- **Don't commit actual audiobook files** to the repository
- Use short test files or metadata-only tests
- Create mock data for web lookup testing
- Test with various filename formats and edge cases

### Common Test Scenarios
```
# Test various filename formats
- "01 - Chapter Name.mp3"
- "Harry_Potter_1_Sorcerers_Stone.mp3"
- "hp1_jim_dale_part01.mp3"
- "Author Name - Book Title - 001.mp3"
- "messy.filename.with.dots.mp3"

# Test directory structures  
- Authors/Author Name/Book Title/
- Series/Series Name/01 - Book Title/
- Random messy structure in Temp/
```

## 🔍 Code Review Guidelines

### For Reviewers
- Focus on logic, performance, and maintainability
- Check error handling and edge cases
- Verify web API integration follows best practices
- Ensure new patterns integrate well with existing learning system

### For Contributors
- Respond promptly to review feedback
- Keep changes focused and atomic
- Explain complex logic with comments
- Be open to suggestions and alternative approaches

## 🌟 Recognition

Contributors will be recognized in:
- README.md acknowledgments
- GitHub contributors page
- Release notes for significant contributions

## 📞 Getting Help

- **Questions**: Open a GitHub Discussion
- **Bugs**: Create an Issue with the bug template
- **Features**: Create an Issue with the feature template
- **General Help**: Comment on existing issues or discussions

## 🎉 Thank You!

Every contribution makes this audiobook management system better for everyone. Whether you're fixing a typo, adding a feature, or improving documentation - it all helps create the ultimate audiobook library tool!

Happy coding! 🚀
