// Diagnostic script to check if dump process is stuck
const fs = require('fs');
const path = require('path');

// Find the latest extracted database
const uploadsDir = 'uploads';
const sqlFiles = fs.readdirSync(uploadsDir)
    .filter(f => f.startsWith('recovery_') && f.endsWith('.sql'))
    .map(f => ({
        name: f,
        path: path.join(uploadsDir, f),
        mtime: fs.statSync(path.join(uploadsDir, f)).mtime,
        size: fs.statSync(path.join(uploadsDir, f)).size
    }))
    .sort((a, b) => b.mtime - a.mtime);

if (sqlFiles.length === 0) {
    console.log('No SQL recovery files found.');
    process.exit(0);
}

const latestFile = sqlFiles[0];
console.log(`Latest SQL file: ${latestFile.name}`);
console.log(`Size: ${Math.round(latestFile.size / 1024 / 1024)} MB`);
console.log(`Last modified: ${latestFile.mtime}`);

const ageSeconds = Math.round((Date.now() - latestFile.mtime.getTime()) / 1000);
console.log(`Age: ${ageSeconds} seconds ago`);

if (ageSeconds > 120) {
    console.log('\n⚠️  WARNING: File hasn\'t been modified in over 2 minutes!');
    console.log('The SQLite dump process is likely STUCK on corrupted data.');
    console.log('\nRecommendations:');
    console.log('1. Kill the current Node.js process');
    console.log('2. Try recovering only specific tables instead of full dump');
    console.log('3. The database may be too corrupted for automatic recovery');
} else {
    console.log('\n✅ File is still being written to. Process is ACTIVE (not stuck).');
    console.log('Large databases can take 10-30 minutes to dump.');
    console.log(`Check again in ${120 - ageSeconds} seconds.`);
}
