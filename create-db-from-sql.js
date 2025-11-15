// Create database from SQL file
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sqlPath = 'uploads/manual_recovery_klopos.sql';
const dbPath = 'uploads/recovered_klopos.db';

console.log('Creating database from SQL file...');
console.log(`Input: ${sqlPath}`);
console.log(`Output: ${dbPath}\n`);

// Delete existing DB if present
if (fs.existsSync(dbPath)) {
    console.log('Removing existing database...');
    fs.unlinkSync(dbPath);
}

console.log('Importing SQL (this may take a few minutes)...\n');

const sqlite3 = spawn('sqlite3', [dbPath], {
    stdio: ['pipe', 'pipe', 'pipe']
});

const inputStream = fs.createReadStream(sqlPath);
let bytesRead = 0;
let lastProgressUpdate = Date.now();

inputStream.on('data', (chunk) => {
    bytesRead += chunk.length;
    const now = Date.now();
    
    if (now - lastProgressUpdate > 3000) {
        const mbRead = Math.round(bytesRead / 1024 / 1024);
        process.stdout.write(`\rImporting... ${mbRead} MB read`);
        lastProgressUpdate = now;
    }
});

inputStream.pipe(sqlite3.stdin);

let stderr = '';

sqlite3.stderr.on('data', (data) => {
    stderr += data.toString();
    const lines = data.toString().trim().split('\n');
    lines.forEach(line => {
        if (line && !line.includes('incomplete input')) {
            console.log(`SQLite: ${line}`);
        }
    });
});

sqlite3.on('close', (code) => {
    const finalMB = Math.round(bytesRead / 1024 / 1024);
    console.log(`\n\nImport complete! Read ${finalMB} MB`);
    
    if (code === 0) {
        const stats = fs.statSync(dbPath);
        const dbSizeMB = Math.round(stats.size / 1024 / 1024);
        
        console.log('\n' + '='.repeat(60));
        console.log('✅ DATABASE CREATED SUCCESSFULLY');
        console.log('='.repeat(60));
        console.log(`Database file: ${dbPath}`);
        console.log(`Database size: ${dbSizeMB} MB`);
        console.log('\nYou can now:');
        console.log(`1. Open the database: sqlite3 "${dbPath}"`);
        console.log(`2. Run queries on your recovered data`);
        console.log(`3. Export specific tables if needed`);
    } else {
        console.log('\n❌ Import failed with exit code:', code);
        if (stderr) {
            console.log('Error output:', stderr);
        }
        process.exit(1);
    }
});

sqlite3.on('error', (err) => {
    console.error('\n❌ Spawn error:', err);
    process.exit(1);
});
