const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔄 Auto Reconnect System Started');
console.log('📱 Akan restart otomatis jika koneksi putus\n');

let child;

function startBot() {
    console.log('🚀 Memulai bot...');
    
    child = spawn('node', ['index.js'], {
        stdio: 'inherit',
        shell: true
    });
    
    child.on('close', (code) => {
        console.log(`\n⚠️ Bot mati dengan code: ${code}`);
        console.log('🔄 Restart dalam 3 detik...\n');
        
        setTimeout(() => {
            startBot();
        }, 3000);
    });
    
    child.on('error', (err) => {
        console.error('❌ Error:', err);
        setTimeout(() => {
            startBot();
        }, 5000);
    });
}

startBot();