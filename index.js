const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");

const P = require("pino");
const fs = require("fs-extra");
const path = require("path");
const { Octokit } = require("@octokit/rest");
const axios = require("axios");
const AdmZip = require("adm-zip");
const extract = require("extract-zip");
const tar = require("tar");
const tmp = require("tmp");
const crypto = require('crypto');
const os = require('os');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const { spawn, execSync } = require("child_process");

const settings = require("./settings");

// =================== CONFIG ===================
const TOKEN = settings.githubToken;
const ALLOWED_USERS = settings.allowedUsers;
const BASE_PATH = settings.basePath;
const BUILD_PATH = path.join(BASE_PATH, "builds");
const TEMP_PATH = path.join(BASE_PATH, "temp");
const MAX_BUILD_TIME = settings.maxBuildTime;
const MAX_BUILDS_KEEP = settings.maxBuildsKeep;
const MEMORY_CONFIG = settings.memoryConfig;

// GitHub Configuration
const GITHUB_TOKEN = settings.githubToken;
const GITHUB_OWNER = settings.githubOwner;
const GITHUB_REPO = settings.githubRepo;
const GITHUB_RELEASE_PREFIX = settings.githubReleasePrefix;

// Buat folder
[BASE_PATH, BUILD_PATH, TEMP_PATH].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Store active builds
const activeBuilds = new Map();
// Store status messages
const statusMessages = new Map();

// =================== MEMORY MANAGEMENT FUNCTIONS ===================

async function getMemoryInfo() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usedPercent = (usedMem / totalMem * 100).toFixed(1);
    const freeMB = Math.floor(freeMem / 1024 / 1024);
    
    let swapTotal = 0, swapFree = 0;
    try {
        const { stdout } = await exec('free -b | grep Swap');
        const parts = stdout.split(/\s+/);
        swapTotal = parseInt(parts[1]) || 0;
        swapFree = parseInt(parts[3]) || 0;
    } catch (e) {}
    
    return {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        usedPercent,
        freeMB,
        swapTotal,
        swapFree,
        swapUsed: swapTotal - swapFree
    };
}

async function checkMemoryAndCleanup(sock, chatId = null, force = false) {
    const mem = await getMemoryInfo();
    const results = [];
    let cleaned = false;
    let freedSpace = 0;
    
    console.log(`📊 Memory check: ${mem.freeMB} MB free (${mem.usedPercent}% used)`);
    
    let level = 'NORMAL';
    if (mem.freeMB < MEMORY_CONFIG.CRITICAL) level = 'CRITICAL';
    else if (mem.freeMB < MEMORY_CONFIG.LOW) level = 'LOW';
    else if (mem.freeMB < MEMORY_CONFIG.NORMAL) level = 'WARNING';
    
    if (chatId && level !== 'NORMAL') {
        await sendWAMessage(sock, chatId, 
            `⚠️ *Memory Warning*\n` +
            `Free: ${mem.freeMB} MB (${mem.usedPercent}% used)\n` +
            `Level: ${level}`
        );
    }
    
    if (level === 'CRITICAL' || force) {
        console.log("🔴 CRITICAL memory! Membersihkan semua...");
        
        if (fs.existsSync(TEMP_PATH)) {
            const tempFiles = fs.readdirSync(TEMP_PATH);
            for (const file of tempFiles) {
                const filePath = path.join(TEMP_PATH, file);
                try {
                    const stat = fs.statSync(filePath);
                    freedSpace += stat.size;
                    fs.removeSync(filePath);
                    cleaned = true;
                } catch (e) {}
            }
            results.push(`📁 Temp: ${tempFiles.length} folder dihapus`);
        }
        
        const gradleCache = path.join(os.homedir(), '.gradle/caches');
        if (fs.existsSync(gradleCache)) {
            try {
                const size = fs.statSync(gradleCache).size;
                freedSpace += size;
                fs.removeSync(gradleCache);
                results.push(`📚 Gradle cache dibersihkan`);
                cleaned = true;
            } catch (e) {}
        }
        
        const flutterCache = path.join(os.homedir(), '.pub-cache');
        const flutterTemp = path.join(flutterCache, 'temp');
        if (fs.existsSync(flutterTemp)) {
            try {
                const size = fs.statSync(flutterTemp).size;
                freedSpace += size;
                fs.removeSync(flutterTemp);
                results.push(`🎯 Flutter temp dibersihkan`);
                cleaned = true;
            } catch (e) {}
        }
        
        try {
            execSync('pkill -f gradle');
            results.push(`🛑 Gradle daemons dihentikan`);
        } catch (e) {}
        
        execSync('sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true');
        
    } else if (level === 'LOW') {
        console.log("🟡 LOW memory! Membersihkan temp...");
        
        if (fs.existsSync(TEMP_PATH)) {
            const tempFiles = fs.readdirSync(TEMP_PATH);
            for (const file of tempFiles) {
                const filePath = path.join(TEMP_PATH, file);
                try {
                    const stat = fs.statSync(filePath);
                    freedSpace += stat.size;
                    fs.removeSync(filePath);
                    cleaned = true;
                } catch (e) {}
            }
            results.push(`📁 Temp: ${tempFiles.length} folder dihapus`);
        }
        
        execSync('sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true');
    }
    
    if (cleaned && chatId && sock) {
        const newMem = await getMemoryInfo();
        const report = `🧹 *Auto Cleanup Done!*\n\n` +
            `${results.join('\n')}\n\n` +
            `💾 Freed: ${formatBytes(freedSpace)}\n` +
            `📊 Memory: ${mem.freeMB} MB → ${newMem.freeMB} MB free`;
        
        await sendWAMessage(sock, chatId, report);
    }
    
    return { level, freed: freedSpace, mem: await getMemoryInfo() };
}

async function ensureMemoryForBuild(sock, chatId, statusMsgId = null) {
    const mem = await getMemoryInfo();
    let action = 'OK';
    
    if (statusMsgId && statusMessages.has(statusMsgId)) {
        await updateStatusMessage(sock, chatId, statusMsgId,
            `🧠 *Checking memory...*\n` +
            `Free: ${mem.freeMB} MB\n` +
            `Target: ${MEMORY_CONFIG.TARGET_FREE} MB`
        );
    }
    
    if (mem.freeMB < MEMORY_CONFIG.TARGET_FREE) {
        console.log(`⚠️ Free memory ${mem.freeMB}MB < target ${MEMORY_CONFIG.TARGET_FREE}MB, cleaning up...`);
        
        if (statusMsgId && statusMessages.has(statusMsgId)) {
            await updateStatusMessage(sock, chatId, statusMsgId,
                `⚠️ *Memory rendah, cleaning up...*\n` +
                `Free: ${mem.freeMB} MB\n` +
                `Target: ${MEMORY_CONFIG.TARGET_FREE} MB`
            );
        }
        
        await checkMemoryAndCleanup(sock, chatId);
        
        const newMem = await getMemoryInfo();
        action = `Cleaned: ${mem.freeMB}MB → ${newMem.freeMB}MB`;
        
        if (newMem.freeMB < MEMORY_CONFIG.LOW) {
            action += ' ⚠️ Masih rendah!';
        }
    }
    
    return { mem, action };
}

// =================== UTILITY FUNCTIONS ===================

function generateUniqueId() {
    return crypto.randomBytes(16).toString('hex');
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function sendWAMessage(sock, jid, text, options = {}) {
    try {
        return await sock.sendMessage(jid, { text, ...options });
    } catch (err) {
        console.log("Error sending message:", err.message);
        return null;
    }
}

async function updateStatusMessage(sock, jid, messageId, newText) {
    try {
        if (statusMessages.has(messageId)) {
            // Edit existing message
            await sock.sendMessage(jid, { 
                text: newText,
                edit: messageId 
            });
        } else {
            // Send new and store
            const sent = await sendWAMessage(sock, jid, newText);
            if (sent) {
                statusMessages.set(sent.key.id, true);
            }
        }
    } catch (err) {
        console.log("Error updating message:", err.message);
    }
}

// =================== CLEANUP FUNCTIONS ===================

async function cleanupAll(sock, chatId, msgId = null) {
    try {
        let deletedCount = 0;
        let freedSpace = 0;
        const results = [];

        if (fs.existsSync(TEMP_PATH)) {
            const tempFiles = fs.readdirSync(TEMP_PATH);
            for (const file of tempFiles) {
                const filePath = path.join(TEMP_PATH, file);
                try {
                    const stat = fs.statSync(filePath);
                    freedSpace += stat.size;
                    fs.removeSync(filePath);
                    deletedCount++;
                } catch (e) {}
            }
            results.push(`📁 Temp: ${deletedCount} folder terhapus`);
        }

        if (fs.existsSync(BUILD_PATH)) {
            const buildFiles = fs.readdirSync(BUILD_PATH)
                .filter(f => f.endsWith('.apk'))
                .map(f => {
                    const filePath = path.join(BUILD_PATH, f);
                    return {
                        name: f,
                        path: filePath,
                        time: fs.statSync(filePath).mtimeMs
                    };
                })
                .sort((a, b) => b.time - a.time);

            if (buildFiles.length > MAX_BUILDS_KEEP) {
                let deletedBuilds = 0;
                for (let i = MAX_BUILDS_KEEP; i < buildFiles.length; i++) {
                    const stat = fs.statSync(buildFiles[i].path);
                    freedSpace += stat.size;
                    fs.unlinkSync(buildFiles[i].path);
                    deletedBuilds++;
                }
                results.push(`📦 Builds: ${deletedBuilds} APK lama dihapus (menyisakan ${MAX_BUILDS_KEEP} terbaru)`);
            } else {
                results.push(`📦 Builds: ${buildFiles.length} APK tersimpan`);
            }
        }

        const gradleCache = path.join(os.homedir(), '.gradle/caches');
        if (fs.existsSync(gradleCache)) {
            try {
                const gradleSize = fs.statSync(gradleCache).size;
                freedSpace += gradleSize;
                fs.removeSync(gradleCache);
                results.push(`📚 Gradle cache: dibersihkan`);
            } catch (e) {}
        }

        const flutterCache = path.join(os.homedir(), '.pub-cache');
        const flutterTemp = path.join(flutterCache, 'temp');
        if (fs.existsSync(flutterTemp)) {
            try {
                const tempStat = fs.statSync(flutterTemp);
                freedSpace += tempStat.size;
                fs.removeSync(flutterTemp);
                results.push(`🎯 Flutter temp: dibersihkan`);
            } catch (e) {}
        }

        try {
            execSync('sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true');
            results.push(`🧠 System cache: dibersihkan`);
        } catch (e) {}

        try {
            execSync('pkill -f gradle 2>/dev/null || true');
            results.push(`🛑 Gradle daemons: dihentikan`);
        } catch (e) {}

        const report = `🧹 *Cleanup Complete!*\n\n` +
            `${results.join('\n')}\n\n` +
            `💾 *Space freed:* ${formatBytes(freedSpace)}\n` +
            `📊 *Current disk usage:*\n\`\`\`\n${execSync('df -h /').toString().trim()}\n\`\`\``;

        if (msgId) {
            await updateStatusMessage(sock, chatId, msgId, report);
        } else {
            await sendWAMessage(sock, chatId, report);
        }

        return { deletedCount, freedSpace };
    } catch (error) {
        console.error("Cleanup error:", error);
        throw error;
    }
}

// =================== FILE DOWNLOAD & EXTRACT ===================

async function downloadAndExtractZip(sock, chatId, message) {
    try {
        const statusMsg = await sendWAMessage(sock, chatId, "📥 *Menerima file ZIP...*");
        const statusId = statusMsg.key.id;
        
        const tempDir = path.join(TEMP_PATH, generateUniqueId());
        fs.mkdirSync(tempDir, { recursive: true });
        
        const zipPath = path.join(tempDir, "source.zip");
        
        // Download file dari WhatsApp
        const stream = await downloadContentFromMessage(message.message.documentMessage, 'document');
        const writer = fs.createWriteStream(zipPath);
        
        for await (const chunk of stream) {
            writer.write(chunk);
        }
        writer.end();
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
        
        await updateStatusMessage(sock, chatId, statusId, "📦 *Mengekstrak source code...*");
        
        // Extract ZIP
        await extract(zipPath, { dir: tempDir });
        
        // Cari Flutter project root
        const files = fs.readdirSync(tempDir);
        let projectRoot = tempDir;
        
        const findPubspec = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                if (fs.statSync(fullPath).isDirectory()) {
                    const result = findPubspec(fullPath);
                    if (result) return result;
                } else if (item === 'pubspec.yaml') {
                    return dir;
                }
            }
            return null;
        };
        
        const pubspecDir = findPubspec(tempDir);
        if (pubspecDir) projectRoot = pubspecDir;
        
        if (!fs.existsSync(path.join(projectRoot, "pubspec.yaml"))) {
            throw new Error("Bukan project Flutter: pubspec.yaml tidak ditemukan");
        }
        
        if (!fs.existsSync(path.join(projectRoot, "lib"))) {
            throw new Error("Project Flutter tidak valid: folder lib tidak ditemukan");
        }
        
        await updateStatusMessage(sock, chatId, statusId, "✅ *Download & Extract Complete!*\n🚀 *Memulai build...*");
        
        return {
            projectRoot,
            tempDir,
            statusMsgId: statusId
        };
        
    } catch (error) {
        console.error("Download error:", error);
        await sendWAMessage(sock, chatId, `❌ *Download Failed:*\n${error.message}`);
        throw error;
    }
}

// =================== FLUTTER BUILD FUNCTIONS ===================

function estimateProgress(log) {
    let progress = 0;
    const stages = [
        { keyword: "Running Gradle task", weight: 10 },
        { keyword: "Running Gradle task 'assembleRelease'", weight: 20 },
        { keyword: ":compile", weight: 30 },
        { keyword: ":lint", weight: 40 },
        { keyword: ":test", weight: 50 },
        { keyword: ":assemble", weight: 60 },
        { keyword: "app-release.apk", weight: 80 },
        { keyword: "Built build/app/outputs", weight: 90 },
        { keyword: "√  Built", weight: 95 }
    ];

    for (const stage of stages) {
        if (log.includes(stage.keyword)) {
            progress = Math.max(progress, stage.weight);
        }
    }

    if (log.includes("FAILURE:") || log.includes("error:") || log.includes("Exception:")) {
        progress = -1;
    }
    return progress;
}

function getCurrentStage(log) {
    if (log.includes("Running Gradle task")) return "⚙️ Gradle Build";
    if (log.includes(":compile")) return "🔨 Compiling";
    if (log.includes(":lint")) return "🔍 Linting";
    if (log.includes(":test")) return "🧪 Testing";
    if (log.includes(":assemble")) return "📦 Assembling";
    if (log.includes("app-release.apk")) return "📱 Generating APK";
    if (log.includes("√  Built")) return "✅ Finalizing";
    return "⏳ Initializing";
}

function getVersion(projectPath) {
    try {
        const pubspecPath = path.join(projectPath, "pubspec.yaml");
        if (fs.existsSync(pubspecPath)) {
            const pubspec = fs.readFileSync(pubspecPath, 'utf8');
            const versionMatch = pubspec.match(/version:\s*(.+)/);
            if (versionMatch && versionMatch[1]) {
                return versionMatch[1].trim().split('+')[0];
            }
        }
    } catch (err) {}
    
    const date = new Date();
    return `${date.getFullYear()}.${(date.getMonth()+1).toString().padStart(2,'0')}.${date.getDate().toString().padStart(2,'0')}`;
}

function generateUniqueTag(version) {
    const date = new Date();
    const timestamp = `${date.getHours().toString().padStart(2,'0')}${date.getMinutes().toString().padStart(2,'0')}${date.getSeconds().toString().padStart(2,'0')}`;
    return `${GITHUB_RELEASE_PREFIX}-v${version}-${timestamp}`;
}

async function uploadToGitHub(filePath, version, sourceDesc = "WhatsApp Upload") {
    try {
        const fileSize = fs.statSync(filePath).size;
        const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
        const fileName = path.basename(filePath);
        const dateStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        
        let tagName = generateUniqueTag(version);
        
        let tagExists = true;
        let retry = 0;
        while (tagExists && retry < 5) {
            try {
                await octokit.repos.getReleaseByTag({
                    owner: GITHUB_OWNER,
                    repo: GITHUB_REPO,
                    tag: tagName
                });
                console.log(`⚠️ Tag ${tagName} exists, generating new... (${retry + 1}/5)`);
                tagName = generateUniqueTag(version);
                retry++;
            } catch (error) {
                if (error.status === 404) tagExists = false;
                else throw error;
            }
        }
        
        if (tagExists) throw new Error("Gagal membuat tag unik");
        
        const releaseName = `Build ${version} - ${dateStr}`;
        
        console.log(`📤 Creating release: ${releaseName} (${tagName})`);
        
        const release = await octokit.repos.createRelease({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            tag_name: tagName,
            name: releaseName,
            body: `## 🤖 Flutter APK Build via WhatsApp\n\n` +
                  `- **Version:** \`${version}\`\n` +
                  `- **Date:** ${dateStr} WIB\n` +
                  `- **File Size:** ${fileSizeMB} MB\n` +
                  `- **Source:** ${sourceDesc}\n\n` +
                  `### 📱 Download\n` +
                  `[APK File](${fileName})`,
            draft: false,
            prerelease: false
        });
        
        console.log(`✅ Release created: ${release.data.html_url}`);
        
        console.log(`📤 Uploading APK (${fileSizeMB} MB)...`);
        
        const fileContent = fs.readFileSync(filePath);
        
        const uploadResponse = await octokit.repos.uploadReleaseAsset({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            release_id: release.data.id,
            name: fileName,
            data: fileContent,
            headers: {
                'content-type': 'application/vnd.android.package-archive',
                'content-length': fileSize
            }
        });
        
        console.log(`✅ APK uploaded: ${uploadResponse.data.browser_download_url}`);
        
        return {
            releaseUrl: release.data.html_url,
            downloadUrl: uploadResponse.data.browser_download_url,
            tagName: tagName
        };
        
    } catch (error) {
        console.error("❌ GitHub upload error:", error.message);
        throw error;
    }
}

// =================== BUILD PROCESS ===================

async function buildFlutterProject(sock, chatId, sourceDesc, projectRoot, tempDir, statusMsgId) {
    return new Promise(async (resolve, reject) => {
        try {
            const startTime = Date.now();
            let buildLog = "";
            let errorCount = 0;
            let warningCount = 0;
            let lastProgress = 0;
            
            await updateStatusMessage(sock, chatId, statusMsgId, "🧠 *Checking memory before build...*");
            const memCheck = await ensureMemoryForBuild(sock, chatId, statusMsgId);
            
            const gradleProps = `
org.gradle.jvmargs=-Xmx${MEMORY_CONFIG.GRADLE_HEAP}m -XX:MaxMetaspaceSize=${MEMORY_CONFIG.GRADLE_META}m -XX:+UseG1GC -XX:+UseStringDeduplication
org.gradle.parallel=true
org.gradle.daemon=false
org.gradle.configureondemand=true
android.useAndroidX=true
android.enableJetifier=true
            `.trim();
            
            const gradlePath = path.join(projectRoot, "android", "gradle.properties");
            if (fs.existsSync(path.dirname(gradlePath))) {
                fs.writeFileSync(gradlePath, gradleProps);
                console.log(`⚙️ Gradle heap: ${MEMORY_CONFIG.GRADLE_HEAP}MB`);
            }
            
            const build = spawn("flutter", [
                "build", "apk", "--release",
                "--no-tree-shake-icons",
                "--target-platform=android-arm64"
            ], { 
                cwd: projectRoot,
                env: {
                    ...process.env,
                    GRADLE_OPTS: `-Xmx${MEMORY_CONFIG.GRADLE_HEAP}m -XX:MaxMetaspaceSize=${MEMORY_CONFIG.GRADLE_META}m -XX:+UseG1GC`,
                    JAVA_OPTS: `-Xmx${MEMORY_CONFIG.GRADLE_HEAP}m`
                }
            });
            
            const memMonitor = setInterval(async () => {
                const mem = await getMemoryInfo();
                if (mem.freeMB < MEMORY_CONFIG.CRITICAL) {
                    console.log("🔴 CRITICAL memory during build!");
                }
            }, 10000);
            
            const timerInterval = setInterval(async () => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                const progress = estimateProgress(buildLog);
                const stage = getCurrentStage(buildLog);
                
                if (progress === lastProgress && elapsed % 10 !== 0) return;
                lastProgress = progress;
                
                let statusIcon = progress < 0 ? "❌" : "⚡";
                let progressBar = progress < 0 ? "[ ERROR ]" : 
                    `[${'█'.repeat(Math.floor(progress/10))}${'░'.repeat(10 - Math.floor(progress/10))}] ${progress}%`;
                
                const lastLines = buildLog.split('\n')
                    .filter(l => l.trim())
                    .slice(-3)
                    .join('\n')
                    .substring(0, 300);
                
                try {
                    await updateStatusMessage(
                        sock,
                        chatId,
                        statusMsgId,
                        `${statusIcon} *Building...*\n` +
                        `⏱️ Elapsed: ${formatTime(elapsed)}\n` +
                        `📍 Stage: ${stage}\n` +
                        `📊 ${progressBar}\n` +
                        `🧠 Memory: ${memCheck.mem.freeMB} MB free\n` +
                        `📝 Last:\n\`\`\`\n${lastLines || "Building..."}\n\`\`\`` +
                        (warningCount > 0 ? `\n⚠️ Warnings: ${warningCount}` : "") +
                        (errorCount > 0 ? `\n❌ Errors: ${errorCount}` : "")
                    );
                } catch (e) {}
            }, 1000);
            
            build.stdout.on("data", (data) => {
                const output = data.toString();
                buildLog += output;
                if (output.toLowerCase().includes("warning")) warningCount++;
                process.stdout.write(".");
            });
            
            build.stderr.on("data", (data) => {
                const error = data.toString();
                buildLog += `[STDERR] ${error}`;
                if (error.toLowerCase().includes("error")) errorCount++;
            });
            
            build.on("close", async (code) => {
                clearInterval(timerInterval);
                clearInterval(memMonitor);
                
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                console.log(`\n📦 Build selesai: ${code}`);
                
                if (code !== 0) {
                    await updateStatusMessage(
                        sock,
                        chatId,
                        statusMsgId,
                        `❌ *Build Failed* after ${formatTime(elapsed)}\n\n` +
                        `📋 Last Log:\n\`\`\`\n${buildLog.slice(-1000)}\n\`\`\``
                    );
                    reject(new Error("Build failed"));
                    return;
                }
                
                const apkPaths = [
                    path.join(projectRoot, "build/app/outputs/flutter-apk/app-release.apk"),
                    path.join(projectRoot, "build/app/outputs/apk/release/app-release.apk")
                ];
                
                let apkPath = null;
                for (const p of apkPaths) {
                    if (fs.existsSync(p)) {
                        apkPath = p;
                        break;
                    }
                }
                
                if (!apkPath) {
                    try {
                        const findResult = execSync(`find ${path.join(projectRoot, "build")} -name "*.apk" | head -1`).toString().trim();
                        if (findResult && fs.existsSync(findResult)) {
                            apkPath = findResult;
                        }
                    } catch (e) {}
                }
                
                if (!apkPath) {
                    await updateStatusMessage(sock, chatId, statusMsgId, "⚠️ Build success but APK not found!");
                    reject(new Error("APK not found"));
                    return;
                }
                
                const version = getVersion(projectRoot);
                const date = new Date();
                const dateStr = `${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2,'0')}${date.getDate().toString().padStart(2,'0')}_${date.getHours().toString().padStart(2,'0')}${date.getMinutes().toString().padStart(2,'0')}`;
                const apkName = `app_v${version}_${dateStr}.apk`;
                const newApkPath = path.join(BUILD_PATH, apkName);
                
                fs.copyFileSync(apkPath, newApkPath);
                
                await updateStatusMessage(
                    sock,
                    chatId,
                    statusMsgId,
                    `📤 *Uploading to GitHub...*\n` +
                    `⏱️ Time: ${formatTime(elapsed)}\n` +
                    `📦 APK: ${apkName}\n` +
                    `⚠️ Warnings: ${warningCount}`
                );
                
                const githubResult = await uploadToGitHub(newApkPath, version, sourceDesc);
                
                const successMsg = 
                    `✅ *Build & Upload Successful!* by Aanz\n\n` +
                    `⏱️ *Waktu:* ${formatTime(elapsed)}\n` +
                    `📦 *Version:* \`${version}\`\n` +
                    `⚠️ *Warnings:* ${warningCount}\n` +
                    `📁 *File:* \`${apkName}\`\n\n` +
                    `📥 *Download APK:*\n${githubResult.releaseUrl}`;
                
                await updateStatusMessage(sock, chatId, statusMsgId, successMsg);
                
                await sendWAMessage(
                    sock,
                    chatId,
                    `📲 *Download APK v${version}*\n\n` +
                    `Klik link di bawah untuk download:\n` +
                    `${githubResult.releaseUrl}`
                );
                
                try { fs.removeSync(tempDir); } catch (e) {}
                
                resolve(githubResult);
            });
            
        } catch (error) {
            reject(error);
        }
    });
}

// =================== WHATSAPP BOT SETUP ===================

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(settings.sessionFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: P({ level: "silent" }),
        printQRInTerminal: false,
        auth: state,
        browser: ["Flutter Builder", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
        console.log('📱 Scan QR Code ini dengan WhatsApp:');
        require('qrcode-terminal').generate(qr, { small: true });
    }

    if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`🔴 Connection closed. Status code: ${statusCode}`);
        
        if (shouldReconnect) {
            console.log('🔄 Mencoba reconnect dalam 5 detik...');
            setTimeout(() => {
                startBot();
            }, 5000);
        } else {
            console.log('🚫 Logged out, hapus folder session dan coba lagi');
            process.exit(1);
        }
    }

    if (connection === "open") {
        console.log('✅ Bot Connected!');
        
        const mem = await getMemoryInfo();
        console.log(`📊 Memory: ${mem.freeMB} MB free`);
        
        // Kirim notifikasi ke owner
        try {
            await sock.sendMessage(`${settings.ownerNumber}@s.whatsapp.net`, { 
                text: `✅ *Flutter Builder Bot Aktif*\n📊 Memory: ${mem.freeMB} MB free` 
            });
        } catch (e) {}
    }
});

// PAIRING CODE ONLY - TAMBAHKAN RETRY LOGIC
if (!sock.authState?.creds?.registered) {
    let retryCount = 0;
    const maxRetries = 5;
    
    const getPairingCode = async () => {
        try {
            console.log('\n🔐 Meminta Pairing Code...');
            const code = await sock.requestPairingCode(settings.pairingNumber);
            
            // Format kode biar gampang dibaca
            const formattedCode = code.match(/.{1,4}/g).join('-');
            
            console.log('\n' + '='.repeat(40));
            console.log('🔐 PAIRING CODE ANDA:');
            console.log('='.repeat(40));
            console.log(`\n📱 ${formattedCode}\n`);
            console.log('='.repeat(40));
            console.log('📌 Cara pairing:');
            console.log('1. Buka WhatsApp > Linked Devices');
            console.log('2. Tap "Pair with phone number"');
            console.log('3. Masukkan kode di atas\n');
            
            // Kirim ke console sebagai alert
            console.log('\x07'); // Bell sound
            console.log('⚠️  PAIRING CODE HANYA BERLAKU 1 MENIT!\n');
            
        } catch (err) {
            retryCount++;
            console.log(`❌ Gagal ambil pairing code (${retryCount}/${maxRetries}):`, err.message);
            
            if (retryCount < maxRetries) {
                console.log(`🔄 Coba lagi dalam 3 detik...\n`);
                setTimeout(getPairingCode, 3000);
            } else {
                console.log('❌ Gagal setelah 5 kali percobaan');
                console.log('📱 Coba metode QR Code...');
                
                // Fallback ke QR Code
                console.log('\n📱 Scan QR Code ini dengan WhatsApp:');
                // QR akan muncul otomatis dari Baileys
            }
        }
    };
    
    setTimeout(getPairingCode, 3000);
}

    // Message handler
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        
        // Skip group messages (optional, bisa diubah)
        if (isGroup) return;

        // Check if user is allowed
        if (!ALLOWED_USERS.includes(sender)) {
            await sendWAMessage(sock, sender, "⛔ Anda tidak diizinkan menggunakan bot ini.");
            return;
        }

        const messageType = Object.keys(msg.message)[0];
        const text = msg.message.conversation || 
                    msg.message.extendedTextMessage?.text || 
                    "";

        // Handle commands
        if (text.startsWith('/') || text.startsWith('!')) {
            const command = text.toLowerCase().split(' ')[0];
            
            switch(command) {
                case '/start':
                case '!start':
                case '/menu':
                case '!menu':
                    const mem = await getMemoryInfo();
                    const menu = 
                        `── *FLUTTER BUILDER* ──\n\n` +
                        `📊 *Memory:* ${mem.freeMB} MB Free\n\n` +
                        `*Commands:*\n` +
                        `▢ Kirim file .zip Flutter project\n` +
                        `▢ /help - Bantuan\n` +
                        `▢ /status - Cek build aktif\n` +
                        `▢ /cancel - Batalkan build\n` +
                        `▢ /clear - Bersihkan file\n` +
                        `▢ /disk - Info disk\n` +
                        `▢ /memory - Info memory\n\n` +
                        `*Format ZIP harus berisi project Flutter dengan pubspec.yaml*`;
                    
                    await sendWAMessage(sock, sender, menu);
                    break;
                    
                case '/help':
                case '!help':
                    const help = 
                        `📚 *Bantuan Flutter Builder*\n\n` +
                        `Cara menggunakan:\n` +
                        `1. ZIP project Flutter kamu\n` +
                        `2. Kirim file .zip ke bot ini\n` +
                        `3. Tunggu proses build (5-10 menit)\n` +
                        `4. Dapatkan link download APK dari GitHub\n\n` +
                        `Pastikan project Flutter sudah benar dan bisa di-build.`;
                    
                    await sendWAMessage(sock, sender, help);
                    break;
                    
                case '/status':
                case '!status':
                    if (activeBuilds.has(sender)) {
                        const buildInfo = activeBuilds.get(sender);
                        const elapsed = Math.floor((Date.now() - buildInfo.startTime) / 1000);
                        await sendWAMessage(sock, sender, 
                            `⚡ *Build sedang berjalan*\n` +
                            `📁 File: ${buildInfo.fileName || 'Unknown'}\n` +
                            `⏱️ Elapsed: ${formatTime(elapsed)}`
                        );
                    } else {
                        await sendWAMessage(sock, sender, "✅ Tidak ada build aktif");
                    }
                    break;
                    
                case '/cancel':
                case '!cancel':
                    if (activeBuilds.has(sender)) {
                        activeBuilds.delete(sender);
                        await sendWAMessage(sock, sender, "🛑 Build dibatalkan");
                    } else {
                        await sendWAMessage(sock, sender, "❌ Tidak ada build aktif");
                    }
                    break;
                    
                case '/clear':
                case '!clear':
                    await sendWAMessage(sock, sender, "🧹 *Membersihkan berkas...*");
                    try {
                        await cleanupAll(sock, sender, msg.key.id);
                    } catch (error) {
                        await sendWAMessage(sock, sender, `❌ *Cleanup Gagal:* ${error.message}`);
                    }
                    break;
                    
                case '/disk':
                case '!disk':
                    try {
                        const diskInfo = execSync('df -h /').toString().trim();
                        const tempSize = fs.existsSync(TEMP_PATH) ? 
                            formatBytes(execSync(`du -sb ${TEMP_PATH} 2>/dev/null | cut -f1`).toString().trim() || 0) : '0 B';
                        const buildSize = fs.existsSync(BUILD_PATH) ?
                            formatBytes(execSync(`du -sb ${BUILD_PATH} 2>/dev/null | cut -f1`).toString().trim() || 0) : '0 B';
                        
                        const report = 
                            `💾 *Disk Usage:*\n\`\`\`\n${diskInfo}\n\`\`\`\n` +
                            `📁 Temp: ${tempSize}\n` +
                            `📦 Builds: ${buildSize}`;
                        
                        await sendWAMessage(sock, sender, report);
                    } catch (error) {
                        await sendWAMessage(sock, sender, `❌ Error: ${error.message}`);
                    }
                    break;
                    
                case '/memory':
                case '!memory':
                    try {
                        const mem = await getMemoryInfo();
                        
                        const report = 
                            `🧠 *Memory Status*\n\n` +
                            `Total: ${formatBytes(mem.total)}\n` +
                            `Used: ${formatBytes(mem.used)} (${mem.usedPercent}%)\n` +
                            `Free: ${formatBytes(mem.free)}\n\n` +
                            `Swap: ${formatBytes(mem.swapUsed)} / ${formatBytes(mem.swapTotal)}\n\n` +
                            `*Thresholds:*\n` +
                            `Critical: < ${MEMORY_CONFIG.CRITICAL} MB\n` +
                            `Low: < ${MEMORY_CONFIG.LOW} MB\n` +
                            `Target: > ${MEMORY_CONFIG.TARGET_FREE} MB`;
                        
                        await sendWAMessage(sock, sender, report);
                    } catch (error) {
                        await sendWAMessage(sock, sender, `❌ Error: ${error.message}`);
                    }
                    break;
            }
        }

        // Handle document (ZIP file)
        if (messageType === 'documentMessage') {
            const doc = msg.message.documentMessage;
            const fileName = doc.fileName || '';
            const mimeType = doc.mimeType || '';
            
            // Check if it's a ZIP file
            if (mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed' || fileName.endsWith('.zip')) {
                
                if (activeBuilds.has(sender)) {
                    await sendWAMessage(sock, sender, 
                        "⚠️ Anda sudah memiliki build aktif. Selesaikan atau ketik /cancel untuk membatalkan."
                    );
                    return;
                }
                
                try {
                    activeBuilds.set(sender, { 
                        fileName: fileName, 
                        startTime: Date.now() 
                    });
                    
                    await sendWAMessage(sock, sender, `📥 *Menerima file:* ${fileName}`);
                    
                    // Check memory before processing
                    await checkMemoryAndCleanup(sock, sender);
                    
                    const { projectRoot, tempDir, statusMsgId } = await downloadAndExtractZip(sock, sender, msg);
                    
                    await buildFlutterProject(sock, sender, `WhatsApp: ${fileName}`, projectRoot, tempDir, statusMsgId);
                    
                    activeBuilds.delete(sender);
                    
                } catch (error) {
                    console.error("Build error:", error);
                    await sendWAMessage(sock, sender, `❌ *Build Error:*\n${error.message}`);
                    activeBuilds.delete(sender);
                }
            } else {
                await sendWAMessage(sock, sender, "❌ *Format tidak didukung.* Kirim file .zip yang berisi project Flutter.");
            }
        }
    });

    return sock;
}

// =================== AUTO CLEANUP & MONITORING ===================

// Clean temp files older than 1 hour
setInterval(() => {
    try {
        if (!fs.existsSync(TEMP_PATH)) return;
        
        const files = fs.readdirSync(TEMP_PATH);
        const oneHourAgo = Date.now() - 3600000;
        let cleaned = 0;
        
        files.forEach(file => {
            const filePath = path.join(TEMP_PATH, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory() && stat.mtimeMs < oneHourAgo) {
                    fs.removeSync(filePath);
                    cleaned++;
                }
            } catch (e) {}
        });
        
        if (cleaned > 0) {
            console.log(`🧹 Auto-cleaned ${cleaned} temp folders`);
        }
    } catch (err) {
        console.log("Auto-cleanup error:", err.message);
    }
}, 3600000);

// Clean old builds (keep last MAX_BUILDS_KEEP)
setInterval(() => {
    try {
        if (!fs.existsSync(BUILD_PATH)) return;
        
        const files = fs.readdirSync(BUILD_PATH)
            .filter(f => f.endsWith('.apk'))
            .map(f => path.join(BUILD_PATH, f))
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

        if (files.length > MAX_BUILDS_KEEP) {
            let deleted = 0;
            for (let i = MAX_BUILDS_KEEP; i < files.length; i++) {
                fs.unlinkSync(files[i]);
                deleted++;
            }
            if (deleted > 0) {
                console.log(`🧹 Auto-cleaned ${deleted} old builds`);
            }
        }
    } catch (err) {
        console.log("Auto-cleanup error:", err.message);
    }
}, 86400000);

// Monitor memory every 5 minutes
setInterval(async () => {
    try {
        const mem = await getMemoryInfo();
        
        if (mem.freeMB < MEMORY_CONFIG.CRITICAL) {
            console.log("🔴 CRITICAL memory detected! Auto-cleaning...");
            await checkMemoryAndCleanup();
        } else if (mem.freeMB < MEMORY_CONFIG.LOW) {
            console.log(`🟡 Low memory: ${mem.freeMB} MB free`);
        } else {
            console.log(`🟢 Memory OK: ${mem.freeMB} MB free`);
        }
    } catch (err) {
        console.log("Memory monitor error:", err.message);
    }
}, 300000);

// Start the bot
console.log("🤖 Starting Flutter Builder WhatsApp Bot...");
console.log(`📁 Base path: ${BASE_PATH}`);
console.log(`👤 Owner: ${settings.ownerNumber}`);
console.log(`🧠 Memory config: Target ${MEMORY_CONFIG.TARGET_FREE}MB free`);
console.log(`🧹 Auto-cleanup: Temp (1 jam), Builds (${MAX_BUILDS_KEEP} terbaru)`);

startBot().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});