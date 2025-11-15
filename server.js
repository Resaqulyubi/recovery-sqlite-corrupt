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

// Progress tracking store
const progressStore = new Map();

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

// Clean up old recovery files (keep only files modified in last 5 minutes)
async function cleanupOldRecoveryFiles() {
    try {
        console.log('[CLEANUP] Starting cleanup of old recovery files...');
        const uploadsDir = 'uploads';
        const files = await fs.readdir(uploadsDir);
        const now = Date.now();
        const fiveMinutesAgo = now - (5 * 60 * 1000); // 5 minutes in milliseconds
        
        let deletedCount = 0;
        
        for (const file of files) {
            const filePath = path.join(uploadsDir, file);
            
            try {
                const stats = await fs.stat(filePath);
                
                // Only delete old recovery-related files, keep recent ones
                if (file.startsWith('recovery_') || 
                    file.startsWith('recovered_') || 
                    file.startsWith('manual_recovery_') || 
                    file.startsWith('manual_recovered_') || 
                    file.startsWith('extracted_')) {
                    
                    // Delete if older than 5 minutes
                    if (stats.mtimeMs < fiveMinutesAgo) {
                        await fs.unlink(filePath);
                        deletedCount++;
                        console.log(`[CLEANUP] Deleted old file: ${file}`);
                    }
                }
            } catch (err) {
                // Skip files that can't be accessed
                console.log(`[CLEANUP] Could not process ${file}:`, err.message);
            }
        }
        
        console.log(`[CLEANUP] Cleanup complete. Deleted ${deletedCount} old file(s)`);
    } catch (error) {
        console.error('[CLEANUP] Cleanup error:', error.message);
        // Don't fail the recovery if cleanup fails
    }
}

// Recovery endpoint
app.post('/api/recover', upload.single('database'), async (req, res) => {
    // Set timeout for large file processing (10 minutes)
    req.setTimeout(600000); // 10 minutes in milliseconds
    res.setTimeout(600000);
    
    const sessionId = req.headers['x-session-id'] || Date.now().toString();
    
    // Clean up old recovery files before starting new recovery
    await cleanupOldRecoveryFiles();
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No database file uploaded' });
        }

        sendProgress(sessionId, { 
            type: 'progress', 
            phase: 'upload', 
            progress: 10, 
            message: 'File uploaded successfully',
            detail: `Received ${formatFileSize(req.file.size)}`
        });

        const { ignoreFreelist, noRowids, lostFoundTable } = req.body;
        let inputPath = req.file.path;
        let originalInputPath = req.file.path; // Keep track of original path for cleanup
        const timestamp = Date.now();
        let baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));
        
        // Handle ZIP files
        if (path.extname(req.file.originalname).toLowerCase() === '.zip') {
            console.log(`Processing ZIP file: ${req.file.originalname} (${req.file.size} bytes)`);
            sendProgress(sessionId, { 
                type: 'progress', 
                phase: 'extraction', 
                progress: 15, 
                message: 'Extracting ZIP archive',
                detail: 'Reading ZIP file contents...'
            });
            
            const extractedPath = await extractSqliteFromZip(inputPath, timestamp, sessionId);
            if (!extractedPath) {
                throw new Error('No SQLite database file found in the ZIP archive');
            }
            
            sendProgress(sessionId, { 
                type: 'progress', 
                phase: 'extraction', 
                progress: 20, 
                message: 'ZIP extraction complete',
                detail: `Extracted ${formatFileSize(extractedPath.size)}`
            });
            
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
        sendProgress(sessionId, { 
            type: 'progress', 
            phase: 'recovery', 
            progress: 25, 
            message: 'Starting database recovery',
            detail: 'Running SQLite recovery command...'
        });
        
        const recoveryResult = await executeRecovery(inputPath, recoverCommand, sqlOutputPath, sessionId);
        
        if (!recoveryResult.success) {
            throw new Error(recoveryResult.error);
        }

        sendProgress(sessionId, { 
            type: 'progress', 
            phase: 'database', 
            progress: 70, 
            message: 'Creating recovered database',
            detail: 'Importing SQL into new database...'
        });

        // Create recovered database from SQL
        const dbCreationResult = await createDatabaseFromSql(sqlOutputPath, dbOutputPath, sessionId);
        
        if (!dbCreationResult.success) {
            throw new Error(dbCreationResult.error);
        }

        sendProgress(sessionId, { 
            type: 'progress', 
            phase: 'stats', 
            progress: 95, 
            message: 'Calculating statistics',
            detail: 'Analyzing recovered data...'
        });

        // Get recovery statistics
        const stats = await getRecoveryStats(sqlOutputPath, dbOutputPath, sessionId);

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

// Manual table-by-table recovery endpoint
app.post('/api/manual-recovery', upload.single('database'), async (req, res) => {
    req.setTimeout(1800000); // 30 minutes
    res.setTimeout(1800000);
    
    const sessionId = req.headers['x-session-id'] || Date.now().toString();
    
    // Clean up old recovery files before starting new recovery
    await cleanupOldRecoveryFiles();
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No database file uploaded' });
        }

        let inputPath = req.file.path;
        let originalInputPath = req.file.path;
        const timestamp = Date.now();
        let baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));

        // Handle ZIP files - extract first
        if (path.extname(req.file.originalname).toLowerCase() === '.zip') {
            console.log(`[MANUAL] Processing ZIP file: ${req.file.originalname}`);
            sendProgress(sessionId, {
                type: 'progress',
                phase: 'extraction',
                progress: 5,
                message: 'Extracting ZIP archive',
                detail: 'Reading ZIP file contents...'
            });
            
            const extractedPath = await extractSqliteFromZip(inputPath, timestamp, sessionId);
            if (!extractedPath) {
                throw new Error('No SQLite database file found in the ZIP archive');
            }
            
            sendProgress(sessionId, {
                type: 'progress',
                phase: 'extraction',
                progress: 10,
                message: 'ZIP extraction complete',
                detail: `Extracted database file`
            });
            
            // Clean up original ZIP file
            await fs.unlink(inputPath);
            inputPath = extractedPath.path;
            baseName = extractedPath.baseName;
        }

        const outputPath = `uploads/manual_recovery_${timestamp}_${baseName}.sql`;
        const dbOutputPath = `uploads/manual_recovered_${timestamp}_${baseName}.db`;

        sendProgress(sessionId, {
            type: 'progress',
            phase: 'recovery',
            progress: 15,
            message: 'Starting manual table-by-table recovery',
            detail: 'This may take a while for large databases...'
        });

        // Use table-by-table recovery directly
        const result = await tryTableByTableRecovery(inputPath, outputPath, sessionId);
        
        if (!result.success) {
            throw new Error(result.error);
        }

        sendProgress(sessionId, {
            type: 'progress',
            phase: 'database',
            progress: 75,
            message: 'Creating recovered database',
            detail: 'Importing SQL into new database...'
        });

        // Create database from recovered SQL
        const dbResult = await createDatabaseFromSql(outputPath, dbOutputPath, sessionId);
        
        if (!dbResult.success) {
            throw new Error(dbResult.error);
        }

        // Clean up original uploaded file
        try {
            await fs.unlink(inputPath);
        } catch (e) {}

        res.json({
            success: true,
            sqlFile: path.basename(outputPath),
            dbFile: path.basename(dbOutputPath),
            tablesRecovered: result.tablesRecovered,
            totalTables: result.tablesRecovered + result.tablesFailed
        });

    } catch (error) {
        console.error('Manual recovery error:', error);
        
        // Clean up files on error
        if (req.file) {
            try {
                await fs.unlink(req.file.path);
            } catch (e) {}
        }
        
        // Also clean up extracted file if it exists
        if (typeof inputPath !== 'undefined' && inputPath !== originalInputPath) {
            try {
                await fs.unlink(inputPath);
            } catch (e) {}
        }
        
        res.status(500).json({ 
            error: error.message || 'Manual recovery failed' 
        });
    }
});

// Check recovery status endpoint
app.get('/api/status', async (req, res) => {
    try {
        const uploadsDir = 'uploads';
        const sqlFiles = require('fs').readdirSync(uploadsDir)
            .filter(f => (f.startsWith('recovery_') || f.startsWith('manual_recovery_')) && f.endsWith('.sql'))
            .map(f => ({
                name: f,
                path: path.join(uploadsDir, f),
                mtime: require('fs').statSync(path.join(uploadsDir, f)).mtime,
                size: require('fs').statSync(path.join(uploadsDir, f)).size
            }))
            .sort((a, b) => b.mtime - a.mtime);

        if (sqlFiles.length === 0) {
            return res.json({
                isActive: false,
                isStuck: false,
                message: 'No recovery files found'
            });
        }

        const latestFile = sqlFiles[0];
        const ageSeconds = Math.round((Date.now() - latestFile.mtime.getTime()) / 1000);
        const sizeMB = Math.round(latestFile.size / 1024 / 1024);

        res.json({
            isActive: ageSeconds <= 120,
            isStuck: ageSeconds > 120,
            fileName: latestFile.name,
            fileSize: `${sizeMB} MB`,
            lastModified: latestFile.mtime.toLocaleString(),
            idleSeconds: ageSeconds
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Force stop recovery endpoint
app.post('/api/force-stop', async (req, res) => {
    try {
        const { exec } = require('child_process');
        const stopped = [];

        // Kill SQLite processes (Windows)
        await new Promise((resolve) => {
            exec('taskkill /F /IM sqlite3.exe', (err, stdout) => {
                if (!err && stdout && !stdout.includes('not found')) {
                    stopped.push('SQLite processes');
                }
                resolve();
            });
        });

        res.json({
            success: stopped.length > 0,
            stopped: stopped.length > 0 ? stopped : ['No processes found']
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
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
function executeRecovery(inputPath, recoverCommand, outputPath, sessionId) {
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
            const altResult = await tryAlternativeRecovery(inputPath, outputPath, sessionId);
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
                    const altResult = await tryAlternativeRecovery(inputPath, outputPath, sessionId);
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
async function tryAlternativeRecovery(inputPath, outputPath, sessionId) {
    console.log('Trying alternative recovery methods...');
    
    // Skip .dump for corrupted databases - go straight to table-by-table
    console.log('Skipping .dump (causes hangs) - using table-by-table recovery...');
    sendProgress(sessionId, {
        type: 'progress',
        phase: 'recovery',
        progress: 30,
        message: 'Using table-by-table recovery',
        detail: 'Recovering each table individually...'
    });
    
    const tableResult = await tryTableByTableRecovery(inputPath, outputPath, sessionId);
    if (tableResult.success) {
        return tableResult;
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

// Try using .dump command - stream output directly to file for large databases
function tryDumpCommand(inputPath, outputPath, sessionId) {
    return new Promise(async (resolve) => {
        console.log('[DUMP] Starting .dump command with streaming output...');
        
        // Get input file size for progress calculation
        let inputSize = 0;
        try {
            const stats = await fs.stat(inputPath);
            inputSize = stats.size;
            console.log(`[DUMP] Input database size: ${formatFileSize(inputSize)}`);
        } catch (e) {
            // Continue anyway
        }
        
        const sqlite3 = spawn('sqlite3', [inputPath, '.dump'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let error = '';
        let bytesWritten = 0;
        let writeError = null;
        let lastProgressUpdate = Date.now();
        let lastDataReceived = Date.now();
        let processComplete = false;
        let lastSignificantProgress = Date.now();
        let bytesAtLastCheck = 0;
        let lastSignificantSize = 0;
        let timeAtLastSignificantSize = Date.now();
        
        // Create write stream to output file FIRST
        const outputStream = require('fs').createWriteStream(outputPath);
        
        outputStream.on('error', (err) => {
            console.error('[DUMP] Write stream error:', err);
            writeError = err;
        });
        
        // Immediate check after 20 seconds if absolutely no data
        setTimeout(() => {
            if (bytesWritten === 0 && !processComplete) {
                process.stderr.write(`[TIMEOUT] Process produced zero bytes after 20s - database too corrupted for .dump!\n`);
                process.stderr.write('[TIMEOUT] Killing process and switching to table-by-table recovery...\n');
                
                processComplete = true;
                try {
                    sqlite3.kill('SIGKILL');
                } catch (e) {}
                
                try {
                    outputStream.end();
                } catch (e) {}
                
                resolve({ 
                    success: false, 
                    error: 'Database too corrupted for full dump - switching to table recovery',
                    timeout: true,
                    partialData: false
                });
            }
        }, 20000); // 20 seconds absolute timeout for zero output

        // Absolute watchdog - check every 30 seconds if stuck at same size
        const processStartTime = Date.now();
        const watchdogInterval = setInterval(() => {
            if (processComplete) return;
            
            const mbWritten = Math.round(bytesWritten / 1024 / 1024);
            const mbLastSignificant = Math.round(lastSignificantSize / 1024 / 1024);
            const timeSinceSignificant = Math.round((Date.now() - timeAtLastSignificantSize) / 1000);
            const timeSinceStart = Math.round((Date.now() - processStartTime) / 1000);
            
            process.stdout.write(`[WATCHDOG] Check: at ${mbWritten} MB, ${timeSinceSignificant}s since last significant progress (${mbLastSignificant} MB), ${timeSinceStart}s since process start\n`);
            
            // If NO output at all for 15 seconds, kill it
            if (bytesWritten === 0 && timeSinceStart >= 15) {
                process.stderr.write(`[WATCHDOG] NO OUTPUT TIMEOUT: Process produced zero bytes after ${timeSinceStart}s!\n`);
                process.stderr.write('[WATCHDOG] .dump command not working - falling back to table-by-table recovery...\n');
                
                processComplete = true;
                clearInterval(heartbeatInterval);
                clearInterval(watchdogInterval);
                
                try {
                    sqlite3.kill('SIGKILL');
                } catch (e) {}
                
                outputStream.end();
                resolve({ 
                    success: false, 
                    error: 'Process produced no output - database may be too corrupted for .dump',
                    timeout: true,
                    partialData: false
                });
            }
            // If stuck at same size for 3 minutes, kill it
            else if (timeSinceSignificant >= 180 && bytesWritten > 0) {
                console.error(`[WATCHDOG] ABSOLUTE TIMEOUT: Stuck at ${mbWritten} MB for ${timeSinceSignificant}s!`);
                console.error('[WATCHDOG] SQLite stuck on corrupted data - killing process and falling back to table recovery...');
                
                processComplete = true;
                clearInterval(heartbeatInterval);
                clearInterval(watchdogInterval);
                
                try {
                    sqlite3.kill('SIGKILL');
                } catch (e) {}
                
                outputStream.end();
                resolve({ 
                    success: false, 
                    error: 'Process stuck on corrupted data - timeout',
                    timeout: true,
                    partialData: bytesWritten > 0
                });
            }
        }, 15000); // Check every 15 seconds
        
        console.log('[DUMP] Watchdog armed - will check every 15s and kill if no output for 15s or stuck for 3 minutes');

        // Heartbeat monitor - log progress every 10 seconds even if no new data
        let heartbeatCount = 0;
        console.log('[DUMP] Setting up heartbeat monitor (10s interval)...');
        const heartbeatInterval = setInterval(() => {
            try {
                heartbeatCount++;
                if (processComplete) {
                    console.log(`[DUMP] Heartbeat #${heartbeatCount} skipped - process already complete`);
                    return;
                }
                
                const mbWritten = Math.round(bytesWritten / 1024 / 1024);
                const timeSinceLastData = Math.round((Date.now() - lastDataReceived) / 1000);
                const progressSinceLastCheck = bytesWritten - bytesAtLastCheck;
                const mbProgressSinceCheck = Math.round(progressSinceLastCheck / 1024 / 1024);
                
                process.stdout.write(`[DUMP] Heartbeat #${heartbeatCount}: ${mbWritten} MB written, ${timeSinceLastData}s since last data, +${mbProgressSinceCheck} MB since last check\n`);
                
                // Update significant progress tracker
                if (progressSinceLastCheck > 1024 * 1024) { // More than 1 MB progress
                    lastSignificantProgress = Date.now();
                    bytesAtLastCheck = bytesWritten;
                }
                
                const timeSinceProgress = Math.round((Date.now() - lastSignificantProgress) / 1000);
                
                // If no significant progress (< 1 MB) for 120 seconds, kill the process
                if (timeSinceProgress > 120 && bytesWritten > 0) {
                    console.error(`[DUMP] TIMEOUT: Only ${mbProgressSinceCheck} MB written in last 120 seconds - killing stuck process`);
                    console.error(`[DUMP] Total written: ${mbWritten} MB. SQLite appears stuck on corrupted data.`);
                    console.error('[DUMP] Will try table-by-table recovery to salvage data...');
                    
                    processComplete = true;
                    clearInterval(heartbeatInterval);
                    
                    try {
                        sqlite3.kill('SIGTERM');
                        setTimeout(() => {
                            try {
                                if (!sqlite3.killed) {
                                    sqlite3.kill('SIGKILL');
                                }
                            } catch (e) {}
                        }, 1000);
                    } catch (e) {
                        console.error('[DUMP] Error killing process:', e);
                    }
                    
                    outputStream.end();
                    resolve({ 
                        success: false, 
                        error: 'Dump process timeout - database too corrupted for full dump',
                        timeout: true,
                        partialData: bytesWritten > 0
                    });
                } else if (timeSinceProgress > 60 && bytesWritten > 0) {
                    console.warn(`[DUMP] WARNING: Only ${mbProgressSinceCheck} MB in last ${timeSinceProgress}s - SQLite may be stuck on corrupted data`);
                }
            } catch (error) {
                console.error('[DUMP] Heartbeat error:', error);
            }
        }, 10000); // Every 10 seconds

        // Pipe stdout directly to file
        sqlite3.stdout.on('data', (data) => {
            bytesWritten += data.length;
            lastDataReceived = Date.now();
            
            // Track significant progress (>10 MB increase) to reset absolute timeout
            if (bytesWritten - lastSignificantSize > 10 * 1024 * 1024) {
                lastSignificantSize = bytesWritten;
                timeAtLastSignificantSize = Date.now();
            }
            
            const now = Date.now();
            
            // Update progress every 3 seconds or every 50MB
            if (now - lastProgressUpdate > 3000 || bytesWritten % (50 * 1024 * 1024) < data.length) {
                const mbWritten = Math.round(bytesWritten / 1024 / 1024);
                console.log(`[DUMP] Written ${mbWritten} MB...`);
                
                // Estimate progress based on typical SQL dump size (usually 1-2x the DB size)
                const estimatedTotal = inputSize * 1.5;
                const progressPercent = Math.min(65, 30 + Math.round((bytesWritten / estimatedTotal) * 35));
                
                sendProgress(sessionId, {
                    type: 'progress',
                    phase: 'recovery',
                    progress: progressPercent,
                    message: 'Dumping database content',
                    detail: `Extracted ${mbWritten} MB so far...`
                });
                
                lastProgressUpdate = now;
            }
        });
        
        sqlite3.stdout.pipe(outputStream);

        sqlite3.stderr.on('data', (data) => {
            const errMsg = data.toString();
            error += errMsg;
            // Log stderr immediately to catch SQLite errors/warnings
            if (errMsg.trim()) {
                console.log('[DUMP] SQLite stderr:', errMsg.trim());
            }
        });

        sqlite3.on('close', async (code) => {
            processComplete = true;
            clearInterval(heartbeatInterval);
            clearInterval(watchdogInterval);
            
            // Wait for write stream to finish
            outputStream.end();
            
            await new Promise(resolve => outputStream.on('finish', resolve));
            
            const finalSize = Math.round(bytesWritten / 1024 / 1024);
            console.log(`[DUMP] Process completed. Total written: ${finalSize} MB, Exit code: ${code}`);
            
            if (writeError) {
                console.log('[DUMP] Failed to write output file:', writeError.message);
                resolve({ success: false, error: writeError.message });
            } else if (code === 0 && bytesWritten > 0) {
                console.log(`[DUMP] Successfully dumped ${finalSize} MB using .dump command`);
                resolve({ success: true });
            } else {
                console.log('[DUMP] .dump command failed:', error);
                resolve({ success: false, error: error || 'No data recovered' });
            }
        });

        sqlite3.on('error', (err) => {
            processComplete = true;
            clearInterval(heartbeatInterval);
            clearInterval(watchdogInterval);
            console.error('[DUMP] Spawn error:', err);
            outputStream.end();
            resolve({ success: false, error: err.message });
        });
    });
}

// Query database helper function
function queryDatabase(dbPath, query) {
    return new Promise((resolve) => {
        const sqlite3 = spawn('sqlite3', [dbPath, '-json', query], {
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
            if (code === 0 && output.trim()) {
                try {
                    const result = JSON.parse(output);
                    resolve(result);
                } catch (e) {
                    console.error('[QUERY] Failed to parse JSON:', e);
                    resolve([]);
                }
            } else {
                console.error('[QUERY] Query failed:', error);
                resolve([]);
            }
        });

        sqlite3.on('error', (err) => {
            console.error('[QUERY] Spawn error:', err);
            resolve([]);
        });
    });
}

// Try table-by-table recovery - recover each table individually and skip corrupted ones
async function tryTableByTableRecovery(inputPath, outputPath, sessionId) {
    console.log('[TABLE] Starting table-by-table recovery...');
    
    try {
        // Get list of all tables
        const tables = await queryDatabase(inputPath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        
        if (!tables || tables.length === 0) {
            console.log('[TABLE] No tables found in database');
            return { success: false, error: 'No tables found' };
        }
        
        console.log(`[TABLE] Found ${tables.length} tables to recover`);
        
        // Write header to file immediately - avoid memory accumulation
        let header = '-- Table-by-Table Recovery\n';
        header += '-- Some tables may be skipped due to corruption\n';
        header += 'PRAGMA foreign_keys=OFF;\n\n';
        
        await fs.writeFile(outputPath, header, 'utf8');
        
        let successCount = 0;
        let failedTables = [];
        
        for (let i = 0; i < tables.length; i++) {
            const tableName = tables[i].name;
            const progress = 35 + Math.round((i / tables.length) * 30); // 35-65%
            
            console.log(`[TABLE] Recovering table ${i + 1}/${tables.length}: ${tableName}`);
            sendProgress(sessionId, {
                type: 'progress',
                phase: 'recovery',
                progress: progress,
                message: 'Recovering tables individually',
                detail: `Table ${i + 1}/${tables.length}: ${tableName}`
            });
            
            const tableResult = await dumpSingleTable(inputPath, tableName);
            
            if (tableResult.success) {
                // Write directly to file to avoid memory issues
                const tableData = `\n-- Table: ${tableName}\n${tableResult.sql}\n`;
                await fs.appendFile(outputPath, tableData, 'utf8');
                successCount++;
                console.log(`[TABLE] ✓ Successfully recovered ${tableName}`);
            } else {
                failedTables.push(tableName);
                console.log(`[TABLE] ✗ Failed to recover ${tableName}: ${tableResult.error}`);
                await fs.appendFile(outputPath, `\n-- Table: ${tableName} (FAILED - ${tableResult.error})\n`, 'utf8');
            }
        }
        
        // Write footer
        let footer = '\n-- Recovery Summary:\n';
        footer += `-- Successfully recovered: ${successCount}/${tables.length} tables\n`;
        if (failedTables.length > 0) {
            footer += `-- Failed tables: ${failedTables.join(', ')}\n`;
        }
        
        await fs.appendFile(outputPath, footer, 'utf8');
        
        console.log(`[TABLE] Recovery complete: ${successCount}/${tables.length} tables recovered`);
        
        if (successCount > 0) {
            return { success: true, tablesRecovered: successCount, tablesFailed: failedTables.length };
        } else {
            return { success: false, error: 'All tables failed to recover' };
        }
        
    } catch (error) {
        console.error('[TABLE] Table-by-table recovery error:', error);
        return { success: false, error: error.message };
    }
}

// Dump a single table with timeout protection
function dumpSingleTable(dbPath, tableName) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log(`[TABLE] Timeout recovering ${tableName}`);
            try {
                sqlite3.kill('SIGTERM');
            } catch (e) {}
            resolve({ success: false, error: 'timeout' });
        }, 30000); // 30 second timeout per table
        
        const sqlite3 = spawn('sqlite3', [dbPath, `.dump "${tableName}"`], {
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
            clearTimeout(timeout);
            
            if (code === 0 && output.length > 0) {
                resolve({ success: true, sql: output });
            } else {
                resolve({ success: false, error: error || 'dump failed' });
            }
        });

        sqlite3.on('error', (err) => {
            clearTimeout(timeout);
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
function createDatabaseFromSql(sqlPath, dbPath, sessionId) {
    return new Promise(async (resolve) => {
        console.log('[DB CREATE] Creating database from SQL file...');
        
        let totalSize = 0;
        try {
            const sqlStats = await fs.stat(sqlPath);
            totalSize = sqlStats.size;
            console.log(`[DB CREATE] SQL file size: ${formatFileSize(sqlStats.size)}`);
        } catch (e) {
            // Continue anyway
        }
        
        const sqlite3 = spawn('sqlite3', [dbPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let error = '';
        let bytesRead = 0;
        let lastLog = Date.now();

        const inputStream = require('fs').createReadStream(sqlPath);
        
        inputStream.on('data', (chunk) => {
            bytesRead += chunk.length;
            // Log progress every 5 seconds
            const now = Date.now();
            if (now - lastLog > 5000) {
                const mbRead = Math.round(bytesRead / 1024 / 1024);
                console.log(`[DB CREATE] Processing: ${mbRead} MB...`);
                
                // Calculate progress (70-95% range for DB creation phase)
                const progressPercent = totalSize > 0 
                    ? Math.min(95, 70 + Math.round((bytesRead / totalSize) * 25))
                    : 80;
                    
                sendProgress(sessionId, {
                    type: 'progress',
                    phase: 'database',
                    progress: progressPercent,
                    message: 'Creating recovered database',
                    detail: `Processing ${mbRead} MB of ${Math.round(totalSize / 1024 / 1024)} MB...`
                });
                
                lastLog = now;
            }
        });

        sqlite3.stderr.on('data', (data) => {
            error += data.toString();
            // Log any warnings/errors during import
            const errStr = data.toString();
            if (errStr.trim()) {
                console.log('[DB CREATE] SQLite message:', errStr.trim());
            }
        });

        sqlite3.on('close', (code) => {
            console.log(`[DB CREATE] SQLite process finished with code ${code}`);
            if (code === 0) {
                console.log('[DB CREATE] Database created successfully');
                resolve({ success: true });
            } else {
                console.log('[DB CREATE] Database creation failed:', error);
                resolve({ 
                    success: false, 
                    error: error || 'Database creation failed' 
                });
            }
        });

        sqlite3.on('error', (err) => {
            console.error('[DB CREATE] Spawn error:', err);
            resolve({ 
                success: false, 
                error: `Failed to create database: ${err.message}` 
            });
        });

        // Pipe SQL file content to sqlite3
        inputStream.pipe(sqlite3.stdin);
    });
}

// Get recovery statistics - query database directly to avoid loading large SQL files
async function getRecoveryStats(sqlPath, dbPath) {
    try {
        const dbStats = await fs.stat(dbPath);
        const sqlStats = await fs.stat(sqlPath);
        
        // Query the recovered database directly for accurate stats
        const tableCount = await queryDatabase(dbPath, "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        
        // Get total row count across all tables
        const tables = await queryDatabase(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        let totalRows = 0;
        
        if (tables && Array.isArray(tables)) {
            for (const table of tables) {
                try {
                    const rowCount = await queryDatabase(dbPath, `SELECT COUNT(*) as count FROM "${table.name}"`);
                    if (rowCount && rowCount[0]) {
                        totalRows += rowCount[0].count || 0;
                    }
                } catch (err) {
                    console.log(`Could not count rows in table ${table.name}:`, err.message);
                }
            }
        }
        
        return {
            tablesRecovered: tableCount && tableCount[0] ? tableCount[0].count : 0,
            recordsRecovered: totalRows,
            dataSize: formatFileSize(dbStats.size),
            sqlSize: formatFileSize(sqlStats.size)
        };
    } catch (error) {
        console.error('Stats error:', error);
        // Fallback: try to estimate from SQL file size without loading into memory
        try {
            const dbStats = await fs.stat(dbPath);
            const sqlStats = await fs.stat(sqlPath);
            return {
                tablesRecovered: 0,
                recordsRecovered: 0,
                dataSize: formatFileSize(dbStats.size),
                sqlSize: formatFileSize(sqlStats.size)
            };
        } catch {
            return {
                tablesRecovered: 0,
                recordsRecovered: 0,
                dataSize: '0 Bytes',
                sqlSize: '0 Bytes'
            };
        }
    }
}

// Helper function to query database
function queryDatabase(dbPath, query) {
    return new Promise((resolve, reject) => {
        const sqlite3 = spawn('sqlite3', [dbPath, '-json', query], {
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
            if (code === 0 && output) {
                try {
                    resolve(JSON.parse(output));
                } catch (e) {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });

        sqlite3.on('error', (err) => {
            resolve(null);
        });
    });
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

// Server-Sent Events endpoint for progress updates
app.get('/api/progress/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    
    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Progress stream connected' })}\n\n`);
    
    // Store client connection
    if (!progressStore.has(sessionId)) {
        progressStore.set(sessionId, []);
    }
    progressStore.get(sessionId).push(res);
    
    // Clean up on close
    req.on('close', () => {
        const clients = progressStore.get(sessionId);
        if (clients) {
            const index = clients.indexOf(res);
            if (index !== -1) {
                clients.splice(index, 1);
            }
            if (clients.length === 0) {
                progressStore.delete(sessionId);
            }
        }
    });
});

// Helper function to send progress updates
function sendProgress(sessionId, data) {
    const clients = progressStore.get(sessionId);
    if (clients && clients.length > 0) {
        const message = `data: ${JSON.stringify(data)}\n\n`;
        clients.forEach(client => {
            try {
                client.write(message);
            } catch (err) {
                console.error('Error sending progress:', err);
            }
        });
    }
}

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
async function extractSqliteFromZip(zipPath, timestamp, sessionId) {
    console.log('[ZIP] Starting extraction process...');
    try {
        // First, try with adm-zip normally
        let zip;
        let zipEntries;
        console.log('[ZIP] Reading ZIP file with adm-zip...');
        
        try {
            console.log('[ZIP] Creating AdmZip instance...');
            zip = new AdmZip(zipPath);
            console.log('[ZIP] Getting ZIP entries...');
            zipEntries = zip.getEntries();
            console.log(`[ZIP] Found ${zipEntries.length} entries in ZIP file`);
        } catch (zipError) {
            console.log('[ZIP] Failed to read ZIP with adm-zip:', zipError.message);
            console.log('[ZIP] Trying alternative method...');
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
