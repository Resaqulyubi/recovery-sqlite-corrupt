// Kill stuck SQLite processes
const { exec } = require('child_process');

console.log('Searching for stuck SQLite processes...');

// Windows: Find and kill sqlite3 processes
exec('tasklist | findstr sqlite3', (err, stdout) => {
    if (stdout) {
        console.log('Found SQLite processes:');
        console.log(stdout);
        
        // Kill all sqlite3 processes
        exec('taskkill //F //IM sqlite3.exe', (err, stdout, stderr) => {
            if (err) {
                console.log('No SQLite processes to kill or error:', stderr);
            } else {
                console.log('✓ Killed stuck SQLite processes');
                console.log(stdout);
            }
        });
    } else {
        console.log('No SQLite processes found');
    }
});

// Also try to find Node processes on port 5000
setTimeout(() => {
    exec('netstat -ano | findstr :5000', (err, stdout) => {
        if (stdout) {
            console.log('\nProcesses using port 5000:');
            console.log(stdout);
            
            // Extract PID from output
            const lines = stdout.split('\n');
            const pids = new Set();
            lines.forEach(line => {
                const match = line.match(/\s+(\d+)\s*$/);
                if (match) {
                    pids.add(match[1]);
                }
            });
            
            if (pids.size > 0) {
                console.log(`\nTo kill these processes, run:`);
                pids.forEach(pid => {
                    console.log(`  taskkill //PID ${pid} //F`);
                });
            }
        }
    });
}, 1000);
