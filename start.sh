#!/bin/bash

echo "🚀 Starting Flutter Builder Bot..."
echo "📱 Memastikan folder session ada..."

# Hapus session corrupt jika ada
if [ -f "./session/creds.json" ]; then
    echo "📁 Session ditemukan"
else
    echo "📁 Session baru akan dibuat"
fi

# Bersihkan cache
echo "🧹 Membersihkan cache..."
rm -rf ./session/*.tmp 2>/dev/null

# Start dengan auto-reconnect
while true; do
    echo "⏰ " $(date)
    echo "🤖 Menjalankan bot..."
    
    node reconnect.js
    
    echo "💤 Bot mati, restart dalam 5 detik..."
    sleep 5
done