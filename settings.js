module.exports = {
    botName: "Flutter Builder Bot",
    ownerName: "Aanz",
    ownerNumber: "628988106426", // Nomor owner (untuk auto-approve)
    pairingNumber: "628988106426", // Nomor untuk pairing (tanpa +)
    sessionFolder: "./session",
    allowedUsers: ["628988106426@s.whatsapp.net"], // Yang boleh pake bot (pakai format JID)
    
    // GitHub Configuration
    githubToken: "your_github_personal_access_token", // GANTI INI!
    githubOwner: "aanzapi",
    githubRepo: "File",
    githubReleasePrefix: "build",
    
    // Path Configuration
    basePath: "/home/flutter-bot",
    
    // Build Configuration
    maxBuildTime: 600000, // 10 menit max build
    maxBuildsKeep: 5, // Jumlah APK yang disimpan
    
    // Memory thresholds (dalam MB)
    memoryConfig: {
        CRITICAL: 512,      // < 512MB: bersihin semua!
        LOW: 1024,          // < 1GB: bersihin temp & cache
        NORMAL: 2048,       // < 2GB: peringatan aja
        TARGET_FREE: 3072,  // Target free memory sebelum build (3GB)
        GRADLE_HEAP: 2048,  // Heap untuk Gradle (2GB)
        GRADLE_META: 1024   // Metaspace untuk Gradle (1GB)
    },
        waConnection: {
        retryDelay: 3000,
        maxRetries: 10,
        printQRInTerminal: false,
        syncFullHistory: false,
        fireInitQueries: false,
        shouldSyncHistoryMessage: false
    }
}
