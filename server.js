const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');
const cors = require('cors');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Production optimizations
if (NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        cb(null, `corrupt_${timestamp}_${file.originalname}`);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.db', '.sqlite', '.sqlite3', '.zip'];
        const fileExtension = path.extname(file.originalname).toLowerCase();
        
        if (allowedExtensions.includes(fileExtension)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only SQLite database files (.db, .sqlite, .sqlite3) or ZIP files are allowed.'));
        }
    },
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

// Ensure uploads directory exists
async function ensureUploadsDir() {
    try {
        await fs.access('uploads');
    } catch {
        await fs.mkdir('uploads', { recursive: true });
    }
}

// Recovery endpoint
app.post('/api/recover', upload.single('database'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No database file uploaded' });
        }

        const { ignoreFreelist, noRowids, lostFoundTable } = req.body;
        let inputPath = req.file.path;
        let originalInputPath = req.file.path; // Keep track of original path for cleanup
        const timestamp = Date.now();
        let baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
        
        // Handle ZIP files
        if (path.extname(req.file.originalname).toLowerCase() === '.zip') {
            const extractedPath = await extractSqliteFromZip(inputPath, timestamp);
            if (!extractedPath) {
                throw new Error('No SQLite database file found in the ZIP archive');
            }
            // Clean up original ZIP file
            await fs.unlink(inputPath);
            inputPath = extractedPath.path;
            baseName = extractedPath.baseName;
        }
        
        const sqlOutputPath = `uploads/recovery_${timestamp}_${baseName}.sql`;
        const dbOutputPath = `uploads/recovered_${timestamp}_${baseName}.db`;

        // Build SQLite recovery command
        let recoverCommand = '.recover';
        const options = [];
        
        if (ignoreFreelist === 'true') {
            options.push('--ignore-freelist');
        }
        
        if (noRowids === 'true') {
            options.push('--no-rowids');
        }
        
        if (lostFoundTable && lostFoundTable !== 'lost_and_found') {
            options.push(`--lost-and-found ${lostFoundTable}`);
        }
        
        if (options.length > 0) {
            recoverCommand += ' ' + options.join(' ');
        }

        // Execute recovery command
        console.log(`Executing recovery command: sqlite3 "${inputPath}" "${recoverCommand}"`);
        const recoveryResult = await executeRecovery(inputPath, recoverCommand, sqlOutputPath);
        
        if (!recoveryResult.success) {
            throw new Error(recoveryResult.error);
        }

        // Create recovered database from SQL
        const dbCreationResult = await createDatabaseFromSql(sqlOutputPath, dbOutputPath);
        
        if (!dbCreationResult.success) {
            throw new Error(dbCreationResult.error);
        }

        // Get recovery statistics
        const stats = await getRecoveryStats(sqlOutputPath, dbOutputPath);

        // Clean up original uploaded file (only if it still exists)
        try {
            await fs.unlink(inputPath);
        } catch (unlinkError) {
            console.log('Original file already cleaned up or not found');
        }

        res.json({
            success: true,
            sqlFile: path.basename(sqlOutputPath),
            dbFile: path.basename(dbOutputPath),
            stats: stats
        });

    } catch (error) {
        console.error('Recovery error:', error);
        
        // Clean up files on error
        if (req.file) {
            try {
                await fs.unlink(req.file.path);
            } catch (cleanupError) {
                console.log('File already cleaned up or not found');
            }
        }
        
        // Also clean up extracted file if it exists
        if (typeof inputPath !== 'undefined' && inputPath !== originalInputPath) {
            try {
                await fs.unlink(inputPath);
            } catch (cleanupError) {
                console.log('Extracted file already cleaned up or not found');
            }
        }
        
        res.status(500).json({ 
            error: error.message || 'Recovery failed' 
        });
    }
});

// Download endpoint for recovered files
app.get('/api/download/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const filePath = path.join('uploads', filename);
        
        // Security check - ensure file is in uploads directory
        const resolvedPath = path.resolve(filePath);
        const uploadsPath = path.resolve('uploads');
        
        if (!resolvedPath.startsWith(uploadsPath)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Check if file exists
        await fs.access(filePath);
        
        // Set appropriate headers
        const ext = path.extname(filename).toLowerCase();
        let contentType = 'application/octet-stream';
        
        if (ext === '.sql') {
            contentType = 'text/sql';
        } else if (['.db', '.sqlite', '.sqlite3'].includes(ext)) {
            contentType = 'application/x-sqlite3';
        }
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        // Stream file to response
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);
        
        // Clean up file after download (optional)
        fileStream.on('end', async () => {
            try {
                // Wait a bit before cleanup to ensure download completed
                setTimeout(async () => {
                    try {
                        await fs.unlink(filePath);
                    } catch (error) {
                        console.error('File cleanup error:', error);
                    }
                }, 5000);
            } catch (error) {
                console.error('Cleanup scheduling error:', error);
            }
        });

    } catch (error) {
        console.error('Download error:', error);
        res.status(404).json({ error: 'File not found' });
    }
});

// Check SQLite version and .recover command availability
function checkSqliteVersion() {
    return new Promise((resolve) => {
        const sqlite3 = spawn('sqlite3', ['--version'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let error = '';

        sqlite3.stdout.on('data', (data) => {
            output += data.toString();
        });

        sqlite3.stderr.on('data', (data) => {
            error += data.toString();
        });

        sqlite3.on('close', async (code) => {
            if (code === 0 && output) {
                console.log('SQLite version:', output.trim());
                const version = output.trim().split(' ')[0];
                
                // Test if .recover command is actually available
                const recoverTest = await testRecoverCommand();
                
                resolve({ 
                    success: true, 
                    version: version,
                    hasRecover: recoverTest.hasRecover,
                    isAndroidSdk: output.includes('platform-tools') || recoverTest.isLimited
                });
            } else {
                resolve({ 
                    success: false, 
                    error: 'SQLite3 not found or not accessible'
                });
            }
        });

        sqlite3.on('error', (err) => {
            resolve({ 
                success: false, 
                error: `SQLite3 not found: ${err.message}`
            });
        });
    });
}

// Test if .recover command is actually available
function testRecoverCommand() {
    return new Promise((resolve) => {
        const sqlite3 = spawn('sqlite3', [':memory:', '.help'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let error = '';

        sqlite3.stdout.on('data', (data) => {
            output += data.toString();
        });

        sqlite3.stderr.on('data', (data) => {
            error += data.toString();
        });

        sqlite3.on('close', (code) => {
            const hasRecover = output.toLowerCase().includes('.recover');
            const isLimited = !hasRecover && (output.includes('platform-tools') || output.length < 1000);
            
            console.log(`.recover command available: ${hasRecover}`);
            if (isLimited) {
                console.log('⚠️  Detected limited SQLite version (possibly Android SDK version)');
            }
            
            resolve({ 
                hasRecover: hasRecover,
                isLimited: isLimited
            });
        });

        sqlite3.on('error', (err) => {
            resolve({ 
                hasRecover: false,
                isLimited: true
            });
        });
    });
}

// Execute SQLite recovery command
function executeRecovery(inputPath, recoverCommand, outputPath) {
    return new Promise(async (resolve) => {
        // First check SQLite version
        const versionCheck = await checkSqliteVersion();
        if (!versionCheck.success) {
            return resolve({
                success: false,
                error: `SQLite3 is not available: ${versionCheck.error}. Please install SQLite3 and ensure it's in your PATH.`
            });
        }
        
        if (!versionCheck.hasRecover) {
            console.log(`SQLite ${versionCheck.version} does not support .recover command, using alternative methods...`);
            if (versionCheck.isAndroidSdk) {
                console.log('Detected Android SDK SQLite - using .dump method instead');
            }
            // Skip .recover and go directly to alternative methods
            const altResult = await tryAlternativeRecovery(inputPath, outputPath);
            return resolve(altResult);
        }
        
        console.log(`Using SQLite ${versionCheck.version} with .recover support`);
        
        // Test if .recover command works by trying it on a simple test
        console.log(`Testing .recover command format...`);
        
        // Try different command formats
        const commandArgs = [inputPath, recoverCommand];
        console.log(`Command: sqlite3 "${inputPath}" "${recoverCommand}"`);
        
        const sqlite3 = spawn('sqlite3', commandArgs, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let error = '';

        sqlite3.stdout.on('data', (data) => {
            output += data.toString();
        });

        sqlite3.stderr.on('data', (data) => {
            error += data.toString();
        });

        sqlite3.on('close', async (code) => {
            try {
                console.log(`SQLite process exited with code: ${code}`);
                console.log(`Output length: ${output.length} characters`);
                console.log(`Error output: ${error}`);
                
                if (code === 0 && output.length > 0) {
                    // Write SQL output to file
                    await fs.writeFile(outputPath, output, 'utf8');
                    console.log(`Recovery SQL written to: ${outputPath}`);
                    resolve({ success: true });
                } else if (code === 0 && output.length === 0) {
                    // Sometimes .recover might succeed but produce no output if database is empty or severely corrupted
                    console.log('Recovery completed but produced no output - database might be empty or severely corrupted');
                    await fs.writeFile(outputPath, '-- No recoverable data found\n', 'utf8');
                    resolve({ success: true });
                } else {
                    // Try alternative recovery method
                    console.log('Standard .recover failed, trying alternative approach...');
                    const altResult = await tryAlternativeRecovery(inputPath, outputPath);
                    resolve(altResult);
                }
            } catch (writeError) {
                resolve({ 
                    success: false, 
                    error: `Failed to write recovery file: ${writeError.message}` 
                });
            }
        });

        sqlite3.on('error', (err) => {
            resolve({ 
                success: false, 
                error: `Failed to execute sqlite3: ${err.message}. Make sure sqlite3 is installed and in PATH.` 
            });
        });
    });
}

// Alternative recovery methods when .recover fails
async function tryAlternativeRecovery(inputPath, outputPath) {
    console.log('Trying alternative recovery methods...');
    
    // Method 1: Try .dump command (older method)
    console.log('Trying .dump command...');
    const dumpResult = await tryDumpCommand(inputPath, outputPath);
    if (dumpResult.success) {
        return dumpResult;
    }
    
    // Method 2: Try to extract schema and data separately
    console.log('Trying schema + data extraction...');
    const schemaResult = await trySchemaExtraction(inputPath, outputPath);
    if (schemaResult.success) {
        return schemaResult;
    }
    
    // Method 3: Try basic table listing and data extraction
    console.log('Trying basic table extraction...');
    const basicResult = await tryBasicExtraction(inputPath, outputPath);
    return basicResult;
}

// Try using .dump command
function tryDumpCommand(inputPath, outputPath) {
    return new Promise((resolve) => {
        const sqlite3 = spawn('sqlite3', [inputPath, '.dump'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let error = '';

        sqlite3.stdout.on('data', (data) => {
            output += data.toString();
        });

        sqlite3.stderr.on('data', (data) => {
            error += data.toString();
        });

        sqlite3.on('close', async (code) => {
            try {
                if (code === 0 && output.length > 0) {
                    await fs.writeFile(outputPath, output, 'utf8');
                    console.log('Successfully recovered using .dump command');
                    resolve({ success: true });
                } else {
                    console.log('.dump command failed:', error);
                    resolve({ success: false, error: error });
                }
            } catch (writeError) {
                resolve({ success: false, error: writeError.message });
            }
        });

        sqlite3.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });
    });
}

// Try extracting schema first, then data
function trySchemaExtraction(inputPath, outputPath) {
    return new Promise((resolve) => {
        const sqlite3 = spawn('sqlite3', [inputPath, '.schema'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let error = '';

        sqlite3.stdout.on('data', (data) => {
            output += data.toString();
        });

        sqlite3.stderr.on('data', (data) => {
            error += data.toString();
        });

        sqlite3.on('close', async (code) => {
            try {
                if (code === 0 && output.length > 0) {
                    let recoverySQL = '-- Schema Recovery\n';
                    recoverySQL += 'PRAGMA foreign_keys=OFF;\n';
                    recoverySQL += 'BEGIN TRANSACTION;\n\n';
                    recoverySQL += output;
                    recoverySQL += '\n\n-- Note: Data extraction may have failed due to corruption\n';
                    recoverySQL += '-- Schema recovered successfully\n';
                    recoverySQL += 'COMMIT;\n';
                    
                    await fs.writeFile(outputPath, recoverySQL, 'utf8');
                    console.log('Successfully recovered schema using .schema command');
                    resolve({ success: true });
                } else {
                    console.log('.schema command failed:', error);
                    resolve({ success: false, error: error });
                }
            } catch (writeError) {
                resolve({ success: false, error: writeError.message });
            }
        });

        sqlite3.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });
    });
}

// Try basic extraction with table listing
function tryBasicExtraction(inputPath, outputPath) {
    return new Promise((resolve) => {
        const sqlite3 = spawn('sqlite3', [inputPath, '.tables'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let error = '';

        sqlite3.stdout.on('data', (data) => {
            output += data.toString();
        });

        sqlite3.stderr.on('data', (data) => {
            error += data.toString();
        });

        sqlite3.on('close', async (code) => {
            try {
                let recoverySQL = '-- Basic Recovery Attempt\n';
                recoverySQL += '-- Database appears to be severely corrupted\n';
                recoverySQL += 'PRAGMA foreign_keys=OFF;\n';
                recoverySQL += 'BEGIN TRANSACTION;\n\n';
                
                if (code === 0 && output.length > 0) {
                    recoverySQL += '-- Tables found:\n';
                    recoverySQL += `-- ${output.trim()}\n\n`;
                    recoverySQL += '-- Note: Table structures and data could not be recovered\n';
                    recoverySQL += '-- due to severe database corruption\n';
                } else {
                    recoverySQL += '-- No tables could be identified\n';
                    recoverySQL += '-- Database is severely corrupted or not a valid SQLite file\n';
                }
                
                recoverySQL += 'COMMIT;\n';
                
                await fs.writeFile(outputPath, recoverySQL, 'utf8');
                console.log('Created basic recovery report');
                resolve({ success: true });
            } catch (writeError) {
                resolve({ success: false, error: writeError.message });
            }
        });

        sqlite3.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });
    });
}

// Create database from SQL file
function createDatabaseFromSql(sqlPath, dbPath) {
    return new Promise((resolve) => {
        const sqlite3 = spawn('sqlite3', [dbPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let error = '';

        sqlite3.stderr.on('data', (data) => {
            error += data.toString();
        });

        sqlite3.on('close', (code) => {
            if (code === 0) {
                resolve({ success: true });
            } else {
                resolve({ 
                    success: false, 
                    error: error || 'Database creation failed' 
                });
            }
        });

        sqlite3.on('error', (err) => {
            resolve({ 
                success: false, 
                error: `Failed to create database: ${err.message}` 
            });
        });

        // Pipe SQL file content to sqlite3
        require('fs').createReadStream(sqlPath).pipe(sqlite3.stdin);
    });
}

// Get recovery statistics
async function getRecoveryStats(sqlPath, dbPath) {
    try {
        const sqlContent = await fs.readFile(sqlPath, 'utf8');
        const dbStats = await fs.stat(dbPath);
        
        // Count tables and insert statements
        const createTableMatches = sqlContent.match(/CREATE TABLE/gi) || [];
        const insertMatches = sqlContent.match(/INSERT INTO/gi) || [];
        
        return {
            tablesRecovered: createTableMatches.length,
            recordsRecovered: insertMatches.length,
            dataSize: formatFileSize(dbStats.size)
        };
    } catch (error) {
        console.error('Stats error:', error);
        return {
            tablesRecovered: 0,
            recordsRecovered: 0,
            dataSize: '0 Bytes'
        };
    }
}

// Format file size helper
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
async function startServer() {
    await ensureUploadsDir();
    
    // Check SQLite availability on startup
    console.log('Checking SQLite3 availability...');
    const versionCheck = await checkSqliteVersion();
    if (!versionCheck.success) {
        console.error('⚠️  WARNING: SQLite3 is not available!');
        console.error('   Error:', versionCheck.error);
        console.error('   Please install SQLite3 and ensure it\'s in your PATH.');
        console.error('   Download from: https://www.sqlite.org/download.html');
    } else if (!versionCheck.hasRecover) {
        if (versionCheck.isAndroidSdk) {
            console.log(`⚠️  Using Android SDK SQLite ${versionCheck.version}`);
            console.log('   .recover command not available, will use .dump method instead');
            console.log('   For better recovery, consider installing full SQLite from sqlite.org');
        } else {
            console.error('⚠️  WARNING: SQLite version is too old!');
            console.error(`   Current version: ${versionCheck.version}`);
            console.error('   Required version: 3.40.0 or later for .recover command');
            console.error('   Will use alternative recovery methods');
        }
    } else {
        console.log(`✅ SQLite ${versionCheck.version} is available with .recover support`);
    }
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`SQLite Recovery Server running on port ${PORT}`);
        console.log(`Environment: ${NODE_ENV}`);
        if (NODE_ENV === 'development') {
            console.log(`Open http://localhost:${PORT} to use the recovery tool`);
        } else {
            console.log('Server is ready to accept connections');
        }
    });
}

// Extract SQLite database from ZIP file using alternative method for corrupted files
async function extractSqliteFromZip(zipPath, timestamp) {
    try {
        // First, try with adm-zip normally
        let zip;
        let zipEntries;
        
        try {
            zip = new AdmZip(zipPath);
            zipEntries = zip.getEntries();
        } catch (zipError) {
            console.log('Failed to read ZIP with adm-zip, trying alternative method...');
            return await extractWithAlternativeMethod(zipPath, timestamp);
        }
        
        console.log('ZIP file contents:');
        zipEntries.forEach(entry => {
            console.log(`- ${entry.entryName} (${entry.header.size} bytes, isDirectory: ${entry.isDirectory})`);
        });
        
        // Look for SQLite database files in the ZIP
        const sqliteExtensions = ['.db', '.sqlite', '.sqlite3'];
        let sqliteEntry = null;
        
        // First, try to find files with SQLite extensions
        for (const entry of zipEntries) {
            if (entry.isDirectory) continue;
            
            const entryExt = path.extname(entry.entryName).toLowerCase();
            console.log(`Checking file: ${entry.entryName}, extension: ${entryExt}`);
            
            if (sqliteExtensions.includes(entryExt)) {
                sqliteEntry = entry;
                console.log(`Found SQLite file: ${entry.entryName}`);
                break;
            }
        }
        
        // If no extension match, look for files that might be SQLite databases
        if (!sqliteEntry) {
            console.log('No files with SQLite extensions found, looking for potential database files...');
            
            for (const entry of zipEntries) {
                if (entry.isDirectory) continue;
                
                const fileName = entry.entryName.toLowerCase();
                if (fileName.includes('db') || fileName.includes('database') || 
                    fileName.includes('sqlite') || fileName.includes('klopos')) {
                    sqliteEntry = entry;
                    console.log(`Found potential database file by name: ${entry.entryName}`);
                    break;
                }
            }
        }
        
        // If still no match, take the largest non-directory file
        if (!sqliteEntry) {
            console.log('No obvious database files found, taking largest file...');
            let largestEntry = null;
            let largestSize = 0;
            
            for (const entry of zipEntries) {
                if (entry.isDirectory) continue;
                
                if (entry.header.size > largestSize) {
                    largestSize = entry.header.size;
                    largestEntry = entry;
                }
            }
            
            if (largestEntry) {
                sqliteEntry = largestEntry;
                console.log(`Taking largest file as potential database: ${largestEntry.entryName} (${largestSize} bytes)`);
            }
        }
        
        if (!sqliteEntry) {
            console.log('No suitable files found in ZIP archive');
            return null;
        }
        
        // Extract the SQLite file
        const sanitizedName = path.basename(sqliteEntry.entryName).replace(/[^a-zA-Z0-9.-]/g, '_');
        const extractedFileName = `extracted_${timestamp}_${sanitizedName}`;
        const extractedPath = path.join('uploads', extractedFileName);
        
        console.log(`Extracting ${sqliteEntry.entryName} to ${extractedPath}`);
        
        // Try to extract the file, handling CRC errors
        try {
            // Try normal extraction first
            zip.extractEntryTo(sqliteEntry, 'uploads/', false, true, false, extractedFileName);
            console.log('Successfully extracted with normal method');
        } catch (extractError) {
            console.log('Normal extraction failed, trying alternative extraction...');
            
            // Try to get raw data without CRC validation
            try {
                const rawData = sqliteEntry.getCompressedData();
                let fileData;
                
                if (sqliteEntry.header.method === 0) {
                    // No compression - use raw data
                    fileData = rawData;
                    console.log('Using uncompressed data');
                } else {
                    // Try to decompress with zlib
                    const zlib = require('zlib');
                    try {
                        fileData = zlib.inflateRawSync(rawData);
                        console.log('Successfully decompressed with zlib');
                    } catch (zlibError) {
                        // Try with inflate instead of inflateRaw
                        fileData = zlib.inflateSync(rawData);
                        console.log('Successfully decompressed with zlib.inflate');
                    }
                }
                
                await fs.writeFile(extractedPath, fileData);
                console.log('Successfully extracted corrupted file data manually');
                
            } catch (manualError) {
                console.error('Manual extraction also failed:', manualError);
                throw new Error(`Cannot extract file: ${sqliteEntry.entryName}`);
            }
        }
        
        // Verify the extracted file exists and has content
        const stats = await fs.stat(extractedPath);
        console.log(`Extracted file size: ${stats.size} bytes`);
        
        return {
            path: extractedPath,
            baseName: path.basename(sqliteEntry.entryName, path.extname(sqliteEntry.entryName)) || 'extracted_database'
        };
        
    } catch (error) {
        console.error('ZIP extraction error:', error);
        return null;
    }
}

// Alternative extraction method using built-in unzip
async function extractWithAlternativeMethod(zipPath, timestamp) {
    console.log('Attempting extraction with built-in unzip command...');
    
    return new Promise((resolve) => {
        const { spawn } = require('child_process');
        const extractDir = path.join('uploads', `temp_extract_${timestamp}`);
        
        // Create extraction directory
        fs.mkdir(extractDir, { recursive: true }).then(() => {
            // Try to use system unzip command
            const unzip = spawn('powershell', [
                '-Command',
                `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`
            ]);
            
            unzip.on('close', async (code) => {
                try {
                    if (code === 0) {
                        console.log('PowerShell extraction successful');
                        
                        // Find the extracted database file
                        const files = await fs.readdir(extractDir, { recursive: true });
                        console.log('Extracted files:', files);
                        
                        for (const file of files) {
                            const filePath = path.join(extractDir, file);
                            const stats = await fs.stat(filePath);
                            
                            if (stats.isFile()) {
                                const fileName = path.basename(file).toLowerCase();
                                if (fileName.includes('db') || fileName.includes('klopos') || 
                                    fileName.endsWith('.db') || fileName.endsWith('.sqlite') || fileName.endsWith('.sqlite3')) {
                                    
                                    // Move the file to the uploads directory
                                    const finalPath = path.join('uploads', `extracted_${timestamp}_${path.basename(file)}`);
                                    await fs.copyFile(filePath, finalPath);
                                    
                                    // Clean up temp directory
                                    await fs.rm(extractDir, { recursive: true, force: true });
                                    
                                    console.log(`Successfully extracted ${file} using PowerShell`);
                                    return resolve({
                                        path: finalPath,
                                        baseName: path.basename(file, path.extname(file))
                                    });
                                }
                            }
                        }
                    }
                    
                    // Clean up temp directory
                    await fs.rm(extractDir, { recursive: true, force: true });
                    resolve(null);
                    
                } catch (error) {
                    console.error('PowerShell extraction error:', error);
                    resolve(null);
                }
            });
            
            unzip.on('error', (error) => {
                console.error('PowerShell command error:', error);
                resolve(null);
            });
            
        }).catch(error => {
            console.error('Failed to create extraction directory:', error);
            resolve(null);
        });
    });
}

startServer().catch(console.error);
