// Quick test to verify setInterval works
console.log('Testing heartbeat mechanism...');

let count = 0;
const interval = setInterval(() => {
    count++;
    console.log(`Heartbeat ${count}: ${new Date().toISOString()}`);
    
    if (count >= 5) {
        console.log('Heartbeat test completed successfully!');
        clearInterval(interval);
        process.exit(0);
    }
}, 2000); // Every 2 seconds

console.log('Interval set up, waiting for heartbeats...');

// Simulate some other work
setTimeout(() => {
    console.log('Background work happening...');
}, 5000);
