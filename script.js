// Global variables
let selectedFile = null;
let recoveryInProgress = false;

// DOM elements
const fileUploadArea = document.getElementById('fileUploadArea');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const optionsSection = document.getElementById('optionsSection');
const actionSection = document.getElementById('actionSection');
const progressSection = document.getElementById('progressSection');
const resultsSection = document.getElementById('resultsSection');
const errorSection = document.getElementById('errorSection');
const recoverBtn = document.getElementById('recoverBtn');

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    setupEventListeners();
});

function setupEventListeners() {
    // File input change
    fileInput.addEventListener('change', handleFileSelect);
    
    // Drag and drop events
    fileUploadArea.addEventListener('dragover', handleDragOver);
    fileUploadArea.addEventListener('dragleave', handleDragLeave);
    fileUploadArea.addEventListener('drop', handleFileDrop);
    fileUploadArea.addEventListener('click', () => fileInput.click());
    
    // Recovery button
    recoverBtn.addEventListener('click', startRecovery);
    
    // Download buttons (will be set up when results are shown)
    setupDownloadButtons();
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        processSelectedFile(file);
    }
}

function handleDragOver(event) {
    event.preventDefault();
    fileUploadArea.classList.add('dragover');
}

function handleDragLeave(event) {
    event.preventDefault();
    fileUploadArea.classList.remove('dragover');
}

function handleFileDrop(event) {
    event.preventDefault();
    fileUploadArea.classList.remove('dragover');
    
    const files = event.dataTransfer.files;
    if (files.length > 0) {
        processSelectedFile(files[0]);
    }
}

function processSelectedFile(file) {
    // Validate file type
    const validExtensions = ['.db', '.sqlite', '.sqlite3', '.zip'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
    
    if (!validExtensions.includes(fileExtension)) {
        showError('Please select a valid SQLite database file (.db, .sqlite, .sqlite3) or ZIP file containing a database');
        return;
    }
    
    selectedFile = file;
    
    // Update UI
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);
    
    // Show file info and options
    fileInfo.style.display = 'block';
    optionsSection.style.display = 'block';
    actionSection.style.display = 'block';
    
    // Add animations
    fileInfo.classList.add('fade-in');
    optionsSection.classList.add('slide-up');
    actionSection.classList.add('slide-up');
    
    // Hide any previous results or errors
    resultsSection.style.display = 'none';
    errorSection.style.display = 'none';
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function startRecovery() {
    if (!selectedFile || recoveryInProgress) return;
    
    recoveryInProgress = true;
    
    // Hide other sections and show progress
    optionsSection.style.display = 'none';
    actionSection.style.display = 'none';
    resultsSection.style.display = 'none';
    errorSection.style.display = 'none';
    progressSection.style.display = 'block';
    progressSection.classList.add('fade-in');
    
    try {
        // Get recovery options
        const options = getRecoveryOptions();
        
        // Perform actual recovery using backend API
        const recoveryResult = await performActualRecovery(options);
        
        // Store recovery result for downloads
        window.recoveryResult = recoveryResult;
        
        // Show results
        showRecoveryResults(recoveryResult.stats);
        
    } catch (error) {
        showError('Recovery failed: ' + error.message);
    } finally {
        recoveryInProgress = false;
    }
}

function getRecoveryOptions() {
    return {
        ignoreFreelist: document.getElementById('ignoreFreelist').checked,
        noRowids: document.getElementById('noRowids').checked,
        lostFoundTable: document.getElementById('lostFoundTable').value || 'lost_and_found'
    };
}

async function performActualRecovery(options) {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const progressPercent = document.getElementById('progressPercent');
    const progressEstimate = document.getElementById('progressEstimate');
    const progressLogContent = document.getElementById('progressLogContent');
    
    // Generate unique session ID for this recovery
    const sessionId = Date.now().toString() + Math.random().toString(36).substring(7);
    
    // Connect to progress stream
    let eventSource = null;
    let startTime = Date.now();
    
    try {
        // Setup SSE connection for progress updates
        eventSource = new EventSource(`/api/progress/${sessionId}`);
        
        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'progress') {
                    // Update progress bar
                    progressFill.style.width = data.progress + '%';
                    progressPercent.textContent = data.progress + '%';
                    progressText.textContent = data.message;
                    
                    // Calculate estimated time
                    const elapsed = Date.now() - startTime;
                    const estimatedTotal = data.progress > 0 ? (elapsed / data.progress) * 100 : 0;
                    const remaining = estimatedTotal - elapsed;
                    
                    if (remaining > 0 && data.progress < 100) {
                        const minutes = Math.floor(remaining / 60000);
                        const seconds = Math.floor((remaining % 60000) / 1000);
                        progressEstimate.textContent = `Est. time remaining: ${minutes}m ${seconds}s`;
                    } else {
                        progressEstimate.textContent = '';
                    }
                    
                    // Add to detailed log
                    const logEntry = document.createElement('div');
                    logEntry.style.padding = '4px 0';
                    logEntry.style.borderBottom = '1px solid #ddd';
                    logEntry.innerHTML = `
                        <span style="color: #16a085; font-weight: bold;">[${data.progress}%]</span>
                        <span style="color: #555;">${data.phase}:</span>
                        ${data.message}
                        ${data.detail ? `<br><span style="color: #7f8c8d; font-size: 0.9em; padding-left: 20px;">→ ${data.detail}</span>` : ''}
                    `;
                    progressLogContent.appendChild(logEntry);
                    
                    // Auto-scroll log to bottom
                    const progressLog = document.getElementById('progressLog');
                    if (progressLog.style.display !== 'none') {
                        progressLog.scrollTop = progressLog.scrollHeight;
                    }
                }
            } catch (e) {
                console.error('Error parsing progress data:', e);
            }
        };
        
        eventSource.onerror = (error) => {
            console.error('SSE connection error:', error);
        };
        
        // Create FormData for file upload
        const formData = new FormData();
        formData.append('database', selectedFile);
        formData.append('ignoreFreelist', options.ignoreFreelist);
        formData.append('noRowids', options.noRowids);
        formData.append('lostFoundTable', options.lostFoundTable);
        
        // Initial progress
        progressFill.style.width = '5%';
        progressPercent.textContent = '5%';
        const fileExtension = '.' + selectedFile.name.split('.').pop().toLowerCase();
        progressText.textContent = fileExtension === '.zip' ? 'Uploading ZIP file...' : 'Uploading database file...';
        
        // Create AbortController with 10-minute timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 minutes
        
        const response = await fetch('/api/recover', {
            method: 'POST',
            body: formData,
            signal: controller.signal,
            headers: {
                'X-Session-ID': sessionId
            }
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Recovery failed');
        }
        
        const result = await response.json();
        
        // Final progress update
        progressFill.style.width = '100%';
        progressPercent.textContent = '100%';
        progressText.textContent = 'Recovery complete!';
        progressEstimate.textContent = '';
        
        // Close SSE connection
        if (eventSource) {
            eventSource.close();
        }
        
        return {
            sqlFile: result.sqlFile,
            dbFile: result.dbFile,
            stats: result.stats
        };
        
    } catch (error) {
        // Close SSE connection on error
        if (eventSource) {
            eventSource.close();
        }
        
        if (error.name === 'AbortError') {
            throw new Error('Recovery timed out after 10 minutes. The file may be too large or severely corrupted.');
        }
        throw new Error(`Recovery failed: ${error.message}`);
    }
}

function toggleProgressLog() {
    const progressLog = document.getElementById('progressLog');
    if (progressLog.style.display === 'none') {
        progressLog.style.display = 'block';
    } else {
        progressLog.style.display = 'none';
    }
}

function generateSampleSqlScript() {
    return `-- SQLite Recovery Script
-- Generated by SQLite Recovery Tool
-- Original file: ${selectedFile.name}

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

-- Table: users
CREATE TABLE users(
    id INTEGER PRIMARY KEY,
    name TEXT,
    email TEXT,
    created_at DATETIME
);

INSERT INTO users VALUES(1,'John Doe','john@example.com','2023-01-01 10:00:00');
INSERT INTO users VALUES(2,'Jane Smith','jane@example.com','2023-01-02 11:00:00');

-- Table: products
CREATE TABLE products(
    id INTEGER PRIMARY KEY,
    name TEXT,
    price REAL,
    category TEXT
);

INSERT INTO products VALUES(1,'Laptop',999.99,'Electronics');
INSERT INTO products VALUES(2,'Mouse',29.99,'Electronics');

COMMIT;`;
}

function showRecoveryResults(stats) {
    progressSection.style.display = 'none';
    resultsSection.style.display = 'block';
    resultsSection.classList.add('fade-in');
    
    // Update stats with actual recovery results
    document.getElementById('tablesRecovered').textContent = stats.tablesRecovered;
    document.getElementById('recordsRecovered').textContent = stats.recordsRecovered.toLocaleString();
    document.getElementById('dataSize').textContent = stats.dataSize;
}

function setupDownloadButtons() {
    document.getElementById('downloadSqlBtn').addEventListener('click', downloadSqlScript);
    document.getElementById('downloadDbBtn').addEventListener('click', downloadRecoveredDb);
}

function downloadSqlScript() {
    if (!window.recoveryResult || !window.recoveryResult.sqlFile) {
        showNotification('No SQL file available for download', 'error');
        return;
    }
    
    // Download from server
    const a = document.createElement('a');
    a.href = `/api/download/${window.recoveryResult.sqlFile}`;
    a.download = window.recoveryResult.sqlFile;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    showNotification('SQL recovery script downloaded successfully', 'success');
}

function downloadRecoveredDb() {
    if (!window.recoveryResult || !window.recoveryResult.dbFile) {
        showNotification('No database file available for download', 'error');
        return;
    }
    
    // Download from server
    const a = document.createElement('a');
    a.href = `/api/download/${window.recoveryResult.dbFile}`;
    a.download = window.recoveryResult.dbFile;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    showNotification('Recovered database downloaded successfully', 'success');
}

function showError(message) {
    progressSection.style.display = 'none';
    resultsSection.style.display = 'none';
    errorSection.style.display = 'block';
    errorSection.classList.add('fade-in');
    
    document.getElementById('errorMessage').textContent = message;
}

function resetTool() {
    // Reset all variables
    selectedFile = null;
    recoveryInProgress = false;
    
    // Reset form
    fileInput.value = '';
    document.getElementById('ignoreFreelist').checked = false;
    document.getElementById('noRowids').checked = false;
    document.getElementById('lostFoundTable').value = '';
    
    // Hide all sections except upload
    fileInfo.style.display = 'none';
    optionsSection.style.display = 'none';
    actionSection.style.display = 'none';
    progressSection.style.display = 'none';
    resultsSection.style.display = 'none';
    errorSection.style.display = 'none';
    
    // Reset progress
    document.getElementById('progressFill').style.width = '0%';
}

// Utility functions
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    // Style the notification
    Object.assign(notification.style, {
        position: 'fixed',
        top: '20px',
        right: '20px',
        padding: '15px 20px',
        borderRadius: '10px',
        color: 'white',
        fontWeight: '500',
        zIndex: '1000',
        opacity: '0',
        transform: 'translateX(100%)',
        transition: 'all 0.3s ease'
    });
    
    // Set background color based on type
    const colors = {
        info: '#667eea',
        success: '#48bb78',
        error: '#e53e3e',
        warning: '#ed8936'
    };
    notification.style.background = colors[type] || colors.info;
    
    // Add to DOM
    document.body.appendChild(notification);
    
    // Animate in
    setTimeout(() => {
        notification.style.opacity = '1';
        notification.style.transform = 'translateX(0)';
    }, 100);
    
    // Remove after delay
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 3000);
}

// Add some helpful tooltips and interactions
document.addEventListener('DOMContentLoaded', function() {
    // Add tooltips to option cards
    const optionCards = document.querySelectorAll('.option-card');
    optionCards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-5px)';
        });
        
        card.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0)';
        });
    });
});

// ========================================
// ADVANCED TOOLS FUNCTIONS
// ========================================

function toggleAdvancedTools() {
    const content = document.getElementById('advancedToolsContent');
    const icon = document.getElementById('toolsToggleIcon');
    
    if (content.style.display === 'none') {
        content.style.display = 'block';
        icon.textContent = '▲';
    } else {
        content.style.display = 'none';
        icon.textContent = '▼';
    }
}

function startManualRecovery() {
    const modal = document.getElementById('manualRecoveryModal');
    modal.style.display = 'flex';
}

function closeManualRecoveryModal() {
    const modal = document.getElementById('manualRecoveryModal');
    modal.style.display = 'none';
    
    // Reset modal state
    document.getElementById('manualRecoveryFileInput').value = '';
    document.getElementById('manualRecoveryProgress').style.display = 'none';
    document.getElementById('manualRecoveryLog').innerHTML = '';
}

async function executeManualRecovery() {
    const fileInput = document.getElementById('manualRecoveryFileInput');
    const file = fileInput.files[0];
    
    if (!file) {
        showNotification('Please select a database file', 'warning');
        return;
    }
    
    // Validate file type
    const validExtensions = ['.db', '.sqlite', '.sqlite3', '.zip'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
    
    if (!validExtensions.includes(fileExtension)) {
        showNotification('Please select a valid SQLite database file (.db, .sqlite, .sqlite3) or ZIP file', 'error');
        return;
    }
    
    const progressDiv = document.getElementById('manualRecoveryProgress');
    const progressFill = document.getElementById('manualProgressFill');
    const progressText = document.getElementById('manualProgressText');
    const logDiv = document.getElementById('manualRecoveryLog');
    
    progressDiv.style.display = 'block';
    progressText.textContent = 'Uploading database...';
    
    try {
        // Upload file and start manual recovery
        const formData = new FormData();
        formData.append('database', file);
        
        const sessionId = Date.now().toString() + Math.random().toString(36).substring(7);
        
        // Connect to SSE for progress
        const eventSource = new EventSource(`/api/progress/${sessionId}`);
        
        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            if (data.type === 'progress') {
                progressFill.style.width = data.progress + '%';
                progressText.textContent = `${data.message} (${data.progress}%)`;
                
                const logEntry = document.createElement('div');
                logEntry.style.padding = '5px';
                logEntry.style.borderBottom = '1px solid #ddd';
                logEntry.innerHTML = `<strong>[${data.progress}%]</strong> ${data.message}`;
                if (data.detail) {
                    logEntry.innerHTML += `<br><span style="color: #666; font-size: 0.9em;">${data.detail}</span>`;
                }
                logDiv.appendChild(logEntry);
                logDiv.scrollTop = logDiv.scrollHeight;
            }
        };
        
        progressText.textContent = 'Starting manual table-by-table recovery...';
        
        const response = await fetch('/api/manual-recovery', {
            method: 'POST',
            body: formData,
            headers: {
                'X-Session-ID': sessionId
            }
        });
        
        eventSource.close();
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Manual recovery failed');
        }
        
        const result = await response.json();
        
        progressFill.style.width = '100%';
        progressText.textContent = `✅ Recovery complete! ${result.tablesRecovered}/${result.totalTables} tables recovered`;
        
        // Provide download links
        const downloadSection = document.createElement('div');
        downloadSection.style.marginTop = '20px';
        downloadSection.innerHTML = `
            <p><strong>Recovery completed successfully!</strong></p>
            <button class="btn btn-primary" onclick="downloadManualRecoveryFile('${result.sqlFile}')">
                <i class="fas fa-download"></i> Download SQL File
            </button>
            <button class="btn btn-primary" onclick="downloadManualRecoveryFile('${result.dbFile}')" style="margin-left: 10px;">
                <i class="fas fa-download"></i> Download Database
            </button>
        `;
        logDiv.appendChild(downloadSection);
        
        showNotification('Manual recovery completed successfully!', 'success');
        
    } catch (error) {
        progressText.textContent = '❌ ' + error.message;
        showNotification('Manual recovery failed: ' + error.message, 'error');
    }
}

function downloadManualRecoveryFile(filename) {
    const a = document.createElement('a');
    a.href = `/api/download/${filename}`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function checkRecoveryStatus() {
    try {
        const response = await fetch('/api/status');
        const status = await response.json();
        
        let message = '';
        if (status.isStuck) {
            message = `⚠️ Recovery appears to be STUCK!\n\n`;
            message += `File: ${status.fileName}\n`;
            message += `Size: ${status.fileSize}\n`;
            message += `Last modified: ${status.lastModified}\n`;
            message += `Idle time: ${status.idleSeconds} seconds\n\n`;
            message += `Recommendation: Use "Force Stop" then try "Manual Table Recovery"`;
        } else if (status.isActive) {
            message = `✅ Recovery is ACTIVE and progressing\n\n`;
            message += `File: ${status.fileName}\n`;
            message += `Size: ${status.fileSize}\n`;
            message += `Last modified: ${status.lastModified}\n`;
            message += `Still writing data...`;
        } else {
            message = `ℹ️ No active recovery process detected\n\n`;
            message += status.message || 'No recovery files found';
        }
        
        alert(message);
        
    } catch (error) {
        showNotification('Failed to check status: ' + error.message, 'error');
    }
}

async function forceStopRecovery() {
    if (!confirm('Are you sure you want to force stop all recovery processes? This will kill any running SQLite processes.')) {
        return;
    }
    
    try {
        const response = await fetch('/api/force-stop', {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showNotification('Recovery processes stopped successfully', 'success');
            alert('Stopped processes:\n' + result.stopped.join('\n'));
        } else {
            showNotification('No processes to stop', 'info');
        }
        
    } catch (error) {
        showNotification('Failed to stop processes: ' + error.message, 'error');
    }
}
