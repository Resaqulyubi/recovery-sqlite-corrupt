// Manual table-by-table recovery script
// Run this when full dump gets stuck

const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');

const dbPath = 'uploads/extracted_1763182079117_klopos.db';
const outputPath = 'uploads/manual_recovery_klopos.sql';

console.log('Starting manual table-by-table recovery...');
console.log(`Database: ${dbPath}`);
console.log(`Output: ${outputPath}\n`);

// Query database helper
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
                    console.error('Failed to parse JSON:', e);
                    resolve([]);
                }
            } else {
                console.error('Query failed:', error);
                resolve([]);
            }
        });

        sqlite3.on('error', (err) => {
            console.error('Spawn error:', err);
            resolve([]);
        });
    });
}

// Dump single table
function dumpSingleTable(dbPath, tableName) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log(`  ⏱ Timeout recovering ${tableName} (skipping)`);
            try {
                sqlite3.kill('SIGKILL');
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

// Main recovery
async function recover() {
    try {
        // Get list of all tables
        console.log('Querying database for table list...');
        const tables = await queryDatabase(dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        
        if (!tables || tables.length === 0) {
            console.log('❌ No tables found in database');
            return;
        }
        
        console.log(`✓ Found ${tables.length} tables\n`);
        console.log('Starting recovery...\n');
        
        // Write header to file immediately
        let header = '-- Manual Table-by-Table Recovery\n';
        header += '-- Some tables may be skipped due to corruption\n';
        header += 'PRAGMA foreign_keys=OFF;\n\n';
        
        await fs.writeFile(outputPath, header, 'utf8');
        
        let successCount = 0;
        let failedTables = [];
        let totalSize = 0;
        
        for (let i = 0; i < tables.length; i++) {
            const tableName = tables[i].name;
            const progress = Math.round((i / tables.length) * 100);
            
            process.stdout.write(`[${progress}%] Table ${i + 1}/${tables.length}: ${tableName}... `);
            
            const tableResult = await dumpSingleTable(dbPath, tableName);
            
            if (tableResult.success) {
                const tableData = `\n-- Table: ${tableName}\n${tableResult.sql}\n`;
                await fs.appendFile(outputPath, tableData, 'utf8');
                successCount++;
                const sizeMB = Math.round(tableResult.sql.length / 1024 / 1024);
                totalSize += tableResult.sql.length;
                console.log(`✓ (${sizeMB} MB)`);
            } else {
                failedTables.push(tableName);
                console.log(`✗ FAILED (${tableResult.error})`);
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
        
        const finalSizeMB = Math.round(totalSize / 1024 / 1024);
        
        console.log('\n' + '='.repeat(60));
        console.log('✅ RECOVERY COMPLETE');
        console.log('='.repeat(60));
        console.log(`Successfully recovered: ${successCount}/${tables.length} tables`);
        console.log(`Failed tables: ${failedTables.length}`);
        console.log(`Output file: ${outputPath}`);
        console.log(`Output size: ${finalSizeMB} MB`);
        
        if (failedTables.length > 0) {
            console.log(`\nFailed tables: ${failedTables.join(', ')}`);
        }
        
    } catch (error) {
        console.error('\n❌ Recovery error:', error);
        process.exit(1);
    }
}

recover();
