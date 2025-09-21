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
    
    // Create FormData for file upload
    const formData = new FormData();
    formData.append('database', selectedFile);
    formData.append('ignoreFreelist', options.ignoreFreelist);
    formData.append('noRowids', options.noRowids);
    formData.append('lostFoundTable', options.lostFoundTable);
    
    // Update progress
    progressFill.style.width = '10%';
    const fileExtension = '.' + selectedFile.name.split('.').pop().toLowerCase();
    progressText.textContent = fileExtension === '.zip' ? 'Uploading and extracting ZIP file...' : 'Uploading database file...';
    
    try {
        const response = await fetch('/api/recover', {
            method: 'POST',
            body: formData
        });
        
        progressFill.style.width = '50%';
        progressText.textContent = 'Running SQLite recovery process...';
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Recovery failed');
        }
        
        const result = await response.json();
        
        progressFill.style.width = '100%';
        progressText.textContent = 'Recovery complete!';
        
        return {
            sqlFile: result.sqlFile,
            dbFile: result.dbFile,
            stats: result.stats
        };
        
    } catch (error) {
        throw new Error(`Recovery failed: ${error.message}`);
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
