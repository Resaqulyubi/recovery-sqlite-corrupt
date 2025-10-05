Demo : 
https://recovery-sqlite.nury.my.id/

Another project check at:
https://portfolio.qulyubis.biz.id/

Support this project:
https://buymeacoffee.com/qulyubi
-------------------------------------

# SQLite Database Recovery Tool

A web-based GUI tool for recovering data from corrupt SQLite database files. This tool provides an easy-to-use interface for the SQLite recovery functionality described in the [official SQLite recovery documentation](https://www.sqlite.org/recovery.html).

## Features

- **Web-based GUI**: User-friendly interface accessible through any modern web browser
- **Drag & Drop Upload**: Easy file upload with drag and drop support
- **Recovery Options**: Support for all SQLite recovery options:
  - `--ignore-freelist`: Skip freelist pages to avoid reintroducing deleted data
  - `--no-rowids`: Don't extract non-INTEGER PRIMARY KEY rowid values
  - `--lost-and-found`: Custom table name for unassociated content
- **Dual Output**: Generate both SQL recovery script and recovered database file
- **Progress Tracking**: Real-time progress updates during recovery process
- **Statistics**: View recovery statistics including tables and records recovered
- **File Downloads**: Download both SQL script and recovered database files

## Prerequisites

Before running this tool, ensure you have:

1. **Node.js** (version 14 or higher)
2. **SQLite3 CLI** installed and accessible in your system PATH
   - Windows: Download from [SQLite Download Page](https://www.sqlite.org/download.html)
   - macOS: `brew install sqlite3`
   - Ubuntu/Debian: `sudo apt-get install sqlite3`
   - CentOS/RHEL: `sudo yum install sqlite`

## Installation

1. Clone or download this repository
2. Navigate to the project directory
3. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Starting the Server

1. Open a terminal in the project directory
2. Start the server:
   ```bash
   npm start
   ```
   Or for development with auto-restart:
   ```bash
   npm run dev
   ```
3. Open your web browser and navigate to `http://localhost:3000`

### Using the Recovery Tool

1. **Upload Database**: 
   - Drag and drop your corrupt SQLite database file onto the upload area
   - Or click "Choose File" to select the file
   - Supported formats: `.db`, `.sqlite`, `.sqlite3`

2. **Configure Options**:
   - **Ignore Freelist**: Check to skip freelist pages (recommended to avoid deleted data)
   - **No ROWIDs**: Check to exclude non-INTEGER PRIMARY KEY rowid values
   - **Lost and Found Table**: Specify custom name for unassociated content (default: "lost_and_found")

3. **Start Recovery**:
   - Click "Start Recovery" button
   - Monitor progress in real-time
   - Wait for completion

4. **Download Results**:
   - **SQL Recovery Script**: Contains SQL commands to reconstruct your database
   - **Recovered Database**: New SQLite database file with recovered data
   - View recovery statistics (tables recovered, records recovered, data size)

## How It Works

This tool implements the SQLite recovery process as described in the official documentation:

1. **Upload**: The corrupt database file is uploaded to the server
2. **Recovery**: The server executes the SQLite CLI command:
   ```bash
   sqlite3 corrupt.db ".recover [options]" > recovery.sql
   ```
3. **Reconstruction**: A new database is created from the recovery SQL:
   ```bash
   sqlite3 recovered.db < recovery.sql
   ```
4. **Download**: Both files are made available for download

## Recovery Options Explained

### --ignore-freelist
- **Purpose**: Ignores pages that appear to be part of the freelist
- **When to use**: When you want to avoid reintroducing previously deleted data
- **Recommendation**: Generally recommended for most recovery scenarios

### --no-rowids
- **Purpose**: Excludes rowid values that are not INTEGER PRIMARY KEY values
- **When to use**: When rowid extraction is causing issues or is not needed
- **Note**: May reduce recovery completeness but can help with certain corruption types

### --lost-and-found TABLE
- **Purpose**: Specifies custom name for content that cannot be associated with a particular table
- **Default**: "lost_and_found"
- **When to use**: When you want a specific name for orphaned data

## File Structure

```
sqlite-recovery-tool/
├── index.html          # Main web interface
├── styles.css          # Styling and responsive design
├── script.js           # Frontend JavaScript logic
├── server.js           # Node.js backend server
├── package.json        # Node.js dependencies
├── README.md           # This file
└── uploads/            # Temporary file storage (created automatically)
```

## Troubleshooting

### "sqlite3 command not found"
- Ensure SQLite3 CLI is installed and in your system PATH
- Test by running `sqlite3 --version` in terminal

### "Recovery failed"
- Check that the uploaded file is a valid SQLite database
- Ensure the database file is not currently in use by another application
- Try different recovery options if the default settings fail

### Large File Uploads
- The tool supports files up to 100MB by default
- For larger files, modify the `fileSize` limit in `server.js`

### Port Already in Use
- Change the PORT in `server.js` or set environment variable:
  ```bash
  PORT=3001 npm start
  ```

## Security Considerations

- Files are temporarily stored on the server during processing
- Uploaded files are automatically deleted after processing
- Downloaded files are cleaned up after a short delay
- The tool is designed for local/trusted network use

## Contributing

Feel free to submit issues, feature requests, or pull requests to improve this tool.

## License

MIT License - see the LICENSE file for details.

## Acknowledgments

- Based on the official SQLite recovery documentation
- Uses the SQLite CLI recovery functionality
- Inspired by the need for a user-friendly recovery interface
