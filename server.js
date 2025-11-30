const {
  Client,
  LocalAuth,
  MessageMedia,
} = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { Perplexity } = require("@perplexity-ai/perplexity_ai");
const youtubeSearch = require("youtube-search-api");
const { YtDlp } = require("ytdlp-nodejs");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Load dotenv only if available (for local development)
try {
  require("dotenv").config({ path: "./.env" });
} catch (e) {
  // dotenv not installed, using env_file from docker-compose
}

console.log("=== Environment Debug ===");
console.log("NODE_ENV:", process.env.NODE_ENV || "(not set)");
console.log("=========================");

// Initialize ytdlp-nodejs
const ytdlp = new YtDlp();
let ffmpegAvailable = false;
let ffmpegPath = "ffmpeg"; // Default, will be updated if found elsewhere

// Find FFmpeg path - check common locations
function findFFmpegPath() {
  const possiblePaths =
    process.platform === "win32"
      ? [
          "ffmpeg",
          "C:\\ffmpeg\\bin\\ffmpeg.exe",
          path.join(process.env.LOCALAPPDATA || "", "ffmpeg", "ffmpeg.exe"),
          path.join(
            __dirname,
            "node_modules",
            "ytdlp-nodejs",
            "bin",
            "ffmpeg.exe"
          ),
          path.join(__dirname, "node_modules", ".bin", "ffmpeg.exe"),
        ]
      : [
          "ffmpeg",
          "/usr/local/bin/ffmpeg",
          "/usr/bin/ffmpeg",
          path.join(__dirname, "node_modules", "ytdlp-nodejs", "bin", "ffmpeg"),
        ];

  for (const p of possiblePaths) {
    if (p === "ffmpeg") continue; // Skip default, check it last
    if (fs.existsSync(p)) {
      console.log(`✓ Found FFmpeg at: ${p}`);
      return p;
    }
  }
  return "ffmpeg"; // Fall back to PATH
}

// Check and download FFmpeg if needed (for proper video conversion)
async function ensureFFmpeg() {
  try {
    const isInstalled = ytdlp.checkInstallation({ ffmpeg: true });
    if (isInstalled) {
      console.log("✓ FFmpeg is available");
      ffmpegAvailable = true;
      ffmpegPath = findFFmpegPath();
      return true;
    }
  } catch (error) {
    // checkInstallation throws if FFmpeg path is not set
    console.log("FFmpeg not found, attempting to download...");
  }

  try {
    await ytdlp.downloadFFmpeg();
    console.log("✓ FFmpeg downloaded successfully");
    ffmpegAvailable = true;
    ffmpegPath = findFFmpegPath();
    return true;
  } catch (error) {
    console.warn("Could not download FFmpeg:", error.message);
    console.warn("Videos may be in MPEG-TS format instead of MP4");
    ffmpegAvailable = false;
    return false;
  }
}

// Run FFmpeg check on startup and wait for it
ensureFFmpeg().catch(console.error);

// Detect Chrome executable path based on OS
function getChromePath() {
  if (process.platform === "win32") {
    const possiblePaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        console.log(`✓ Found Chrome at: ${p}`);
        return p;
      }
    }
    return undefined;
  } else if (process.platform === "darwin") {
    const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(macPath)) {
      console.log(`✓ Found Chrome at: ${macPath}`);
      return macPath;
    }
    return undefined;
  } else {
    // Linux/Docker
    const linuxPaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter(Boolean);
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) {
        console.log(`✓ Found Chrome at: ${p}`);
        return p;
      }
    }
    return undefined;
  }
}

// Use local Chrome - RemoteAuth doesn't work with WebSocket browsers
const puppeteerConfig = {
  executablePath: getChromePath(),
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--no-first-run",
    "--no-zygote",
    "--disable-extensions",
  ],
};

console.log("=== Puppeteer Config ===");
console.log("Using local Chrome");
console.log("Config:", JSON.stringify(puppeteerConfig, null, 2));
console.log("========================");

// Use LocalAuth with volume mount for session persistence
// Since we're mounting .wwebjs_auth as a Docker volume, LocalAuth is simpler
// The session directory will persist across container restarts
const authStrategy = new LocalAuth({
  clientId: "whatsapp-bot",
  dataPath: "./.wwebjs_auth",
});

console.log("=== Auth Strategy ===");
console.log("Using: LocalAuth (volume-mounted)");
console.log("=====================");

const client = new Client({
  authStrategy: authStrategy,
  puppeteer: puppeteerConfig,
});

const client_perplexity = new Perplexity({
  PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
});

// Create temp directory if it doesn't exist
const TEMP_DIR = path.join(__dirname, "temp");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Convert video to MP4 (H.264 + AAC) for iOS/Android compatibility
async function convertToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`Converting ${path.basename(inputPath)} to MP4...`);

    const args = [
      "-i",
      inputPath,
      "-c:v",
      "libx264", // H.264 video codec
      "-c:a",
      "aac", // AAC audio codec
      "-preset",
      "fast", // Faster encoding
      "-crf",
      "23", // Quality (lower = better, 18-28 is good)
      "-movflags",
      "+faststart", // Enable streaming
      "-y", // Overwrite output
      outputPath,
    ];

    const ffmpeg = spawn(ffmpegPath, args);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
      // Log progress (FFmpeg outputs to stderr)
      const match = data.toString().match(/time=(\d{2}:\d{2}:\d{2})/);
      if (match) {
        process.stdout.write(`\rConverting: ${match[1]}`);
      }
    });

    ffmpeg.on("close", (code) => {
      console.log(""); // New line after progress
      if (code === 0) {
        console.log(`✓ Converted to MP4 successfully`);
        resolve(outputPath);
      } else {
        reject(
          new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`)
        );
      }
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`FFmpeg error: ${err.message}`));
    });
  });
}

async function download_video(url, filename) {
  const baseFilename = filename.replace(/\.[^.]+$/, ""); // Remove any extension
  const mp4Path = path.join(TEMP_DIR, `${baseFilename}.mp4`);

  // Check if converted MP4 already exists in cache
  if (fs.existsSync(mp4Path)) {
    const stats = fs.statSync(mp4Path);
    if (stats.size > 0) {
      console.log(`✓ Found cached MP4: ${mp4Path}`);
      console.log(`  Cache size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      return mp4Path;
    }
    fs.unlinkSync(mp4Path);
  }

  // Check if original file exists (any extension) - we can convert it
  const cachedFiles = fs
    .readdirSync(TEMP_DIR)
    .filter(
      (f) =>
        f.startsWith(baseFilename) &&
        !f.includes(".part") &&
        !f.includes(".f") &&
        !f.endsWith(".mp4")
    );

  if (cachedFiles.length > 0) {
    const originalPath = path.join(TEMP_DIR, cachedFiles[0]);
    const stats = fs.statSync(originalPath);
    if (stats.size > 0) {
      console.log(`✓ Found cached original: ${originalPath}`);
      // Convert to MP4
      if (ffmpegAvailable) {
        try {
          await convertToMp4(originalPath, mp4Path);
          return mp4Path;
        } catch (error) {
          console.error("Conversion failed:", error.message);
          // Fall back to original
          return originalPath;
        }
      }
      return originalPath;
    }
    fs.unlinkSync(originalPath);
  }

  // Clean up any partial downloads
  const partialFiles = fs
    .readdirSync(TEMP_DIR)
    .filter(
      (f) =>
        f.startsWith(baseFilename) && (f.includes(".f") || f.includes(".part"))
    );
  partialFiles.forEach((f) => {
    const partialPath = path.join(TEMP_DIR, f);
    if (fs.existsSync(partialPath)) {
      fs.unlinkSync(partialPath);
    }
  });

  console.log(`Starting download for: ${baseFilename}`);

  try {
    // Use the global ffmpegAvailable flag set during startup
    const hasFFmpeg = ffmpegAvailable;

    // Use highest quality
    const formatOptions = hasFFmpeg
      ? {
          filter: "mergevideo",
          quality: "highest",
          format: "mp4",
        }
      : {
          filter: "audioandvideo",
          type: "mp4",
          quality: "highest",
        };

    console.log(
      `Using format: ${formatOptions.filter} @ ${
        formatOptions.quality
      } (FFmpeg: ${hasFFmpeg ? "yes" : "no"})`
    );

    // Use downloadAsync - let ytdlp add extension
    await ytdlp.downloadAsync(url, {
      format: formatOptions,
      output: path.join(TEMP_DIR, baseFilename),
      onProgress: (progress) => {
        if (progress.percent) {
          console.log(`Download progress: ${progress.percent}%`);
        }
      },
    });

    console.log("Download completed");
  } catch (error) {
    console.error("ytdlp-nodejs error:", error);
    throw new Error(`Download failed: ${error.message}`);
  }

  // Find the downloaded file
  const downloadedFiles = fs
    .readdirSync(TEMP_DIR)
    .filter(
      (f) =>
        f.startsWith(baseFilename) && !f.includes(".part") && !f.includes(".f")
    );

  if (downloadedFiles.length === 0) {
    throw new Error(`File not created for ${baseFilename}`);
  }

  // Sort to get the most recently created file
  const sortedFiles = downloadedFiles.sort((a, b) => {
    const aTime = fs.statSync(path.join(TEMP_DIR, a)).mtimeMs;
    const bTime = fs.statSync(path.join(TEMP_DIR, b)).mtimeMs;
    return bTime - aTime;
  });

  const downloadedPath = path.join(TEMP_DIR, sortedFiles[0]);
  const ext = path.extname(downloadedPath).toLowerCase();

  console.log(`Downloaded file: ${sortedFiles[0]}`);

  const stats = fs.statSync(downloadedPath);
  console.log(`File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  if (stats.size === 0) {
    throw new Error("Downloaded file is empty");
  }

  // Convert to MP4 if not already MP4 (for iOS compatibility)
  if (ext !== ".mp4") {
    console.log(`File is ${ext}, needs conversion to MP4`);
    console.log(`FFmpeg available: ${ffmpegAvailable}, path: ${ffmpegPath}`);

    if (ffmpegAvailable) {
      try {
        await convertToMp4(downloadedPath, mp4Path);
        return mp4Path;
      } catch (error) {
        console.error("Conversion failed, using original:", error.message);
        return downloadedPath;
      }
    } else {
      console.log("FFmpeg not available, skipping conversion");
      return downloadedPath;
    }
  }

  // If already MP4, rename to expected path
  if (ext === ".mp4" && downloadedPath !== mp4Path) {
    fs.renameSync(downloadedPath, mp4Path);
    return mp4Path;
  }

  console.log("✓ File downloaded successfully");
  return downloadedPath;
}

async function getYouTubeVideoInfo(url) {
  try {
    const info = await ytdlp.getInfoAsync(url);
    return info;
  } catch (error) {
    console.error("Error getting video info:", error);
    throw new Error("Failed to get video information");
  }
}

async function searchYouTube(query) {
  try {
    const results = await youtubeSearch.GetListByKeyword(query, false, 15);
    let formattedString = "";
    results.items.forEach((video, index) => {
      const title = video.title || "No title";
      const videoId = video.id;
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const channelTitle = video.channelTitle || "Unknown channel";
      const length = video.length?.simpleText || "N/A";
      const isLive = video.isLive ? " (Live)" : "";
      formattedString += `Channel: ${channelTitle}\n`;
      formattedString += `${index + 1}. ${title} ${isLive}\n`;
      formattedString += `Length: ${length}\n`;
      formattedString += `URL: ${url}\n`;
      formattedString += `\n`;
    });
    return formattedString;
  } catch (error) {
    console.error("Error searching YouTube:", error);
    throw error;
  }
}

async function get_completion(input) {
  const completion = await client_perplexity.chat.completions.create({
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant. Give concise answers. Keep it brief.",
      },
      {
        role: "user",
        content: input,
      },
    ],
    model: "sonar",
  });
  return completion.choices[0].message.content;
}

function tokenizer(input) {
  let message = input;
  let search_term = message.split(" ");
  let only_search = [];
  let command = search_term[0];
  search_term.shift();
  for (let word of search_term) {
    if (word == "" || word == " ") continue;
    only_search.push(word.replace(" ", ""));
  }
  return [command, only_search];
}

// Helper function to sanitize filename
function sanitizeFilename(filename) {
  return filename
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 100);
}

client.on("qr", (qr) => {
  console.log("QR RECEIVED", qr);
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("Client is ready!");
});

client.on("authenticated", () => {
  console.log("✓ Client authenticated!");
});

client.on("auth_failure", (msg) => {
  console.error("Authentication failure:", msg);
});

client.on("disconnected", (reason) => {
  console.log("Client disconnected:", reason);
});

client.on("message_create", async (msg) => {
  let [command, only_search] = tokenizer(msg.body);
  const chat = await msg.getChat();

  if (command == "!ping") {
    await chat.sendMessage("pong");
    await chat.sendMessage("Search terms: " + only_search.join(" "));
  }

  if (command == "!llm") {
    let query = only_search.join(" ");
    let response = await get_completion(query);
    await chat.sendMessage("Q: " + query + "\nA: " + response);
  }

  if (command == "!yt") {
    let query = only_search.join(" ");
    let yt_results = await searchYouTube(query);
    await chat.sendMessage(
      "YouTube Search Results for: " + query + "\n\n" + yt_results
    );
  }

  if (command == "!help" || command == "!commands") {
    const helpText = `📋 *Available Commands*

*YouTube*
!yt <query> - Search YouTube
!ytdl <url> - Download YouTube video

*Cache*
!cache - Show cached videos
!dl <#> - Send cached video by number

*Other*
!llm <question> - Ask AI a question
!ping - Check if bot is online
!help - Show this help message`;

    await chat.sendMessage(helpText);
  }

  if (command == "!cache" || command == "!showcache") {
    try {
      const files = fs
        .readdirSync(TEMP_DIR)
        .filter((f) => f.endsWith(".mp4"))
        .sort((a, b) => {
          const aTime = fs.statSync(path.join(TEMP_DIR, a)).mtimeMs;
          const bTime = fs.statSync(path.join(TEMP_DIR, b)).mtimeMs;
          return bTime - aTime; // Newest first
        });

      if (files.length === 0) {
        await chat.sendMessage("📁 Cache is empty. No videos downloaded yet.");
        return;
      }

      let cacheList = "📁 *Cached Videos*\n\n";
      files.forEach((file, index) => {
        const stats = fs.statSync(path.join(TEMP_DIR, file));
        const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
        const name = file.replace(".mp4", "").substring(0, 40);
        cacheList += `*#${index + 1}* - ${name}${
          file.length > 44 ? "..." : ""
        } (${sizeMB} MB)\n`;
      });

      cacheList += `\n💡 Use !dl <#> to send a cached video`;
      await chat.sendMessage(cacheList);
    } catch (error) {
      console.error("Error listing cache:", error);
      await chat.sendMessage("❌ Error listing cache: " + error.message);
    }
  }

  if (command == "!dl") {
    try {
      const index = parseInt(only_search[0]?.replace("#", "")) - 1;

      if (isNaN(index)) {
        await chat.sendMessage(
          "❌ Please provide a valid number.\nUsage: !dl #1 or !dl 1"
        );
        return;
      }

      const files = fs
        .readdirSync(TEMP_DIR)
        .filter((f) => f.endsWith(".mp4"))
        .sort((a, b) => {
          const aTime = fs.statSync(path.join(TEMP_DIR, a)).mtimeMs;
          const bTime = fs.statSync(path.join(TEMP_DIR, b)).mtimeMs;
          return bTime - aTime;
        });

      if (index < 0 || index >= files.length) {
        await chat.sendMessage(
          `❌ Invalid number. Use !cache to see available videos (1-${files.length}).`
        );
        return;
      }

      const filePath = path.join(TEMP_DIR, files[index]);
      const stats = fs.statSync(filePath);
      const fileSizeMB = stats.size / 1024 / 1024;

      await chat.sendMessage(
        `📤 Sending: ${files[index]} (${fileSizeMB.toFixed(1)} MB)...`
      );

      const fileData = fs.readFileSync(filePath);
      const base64Data = fileData.toString("base64");
      const media = new MessageMedia(
        "video/mp4",
        base64Data,
        files[index],
        stats.size
      );

      // NOTE: Do NOT use sendAudioAsVoice: true here - it breaks video sending!
      await chat.sendMessage(media, {
        sendMediaAsDocument: true,
      });

      await chat.sendMessage("✅ Video sent successfully!");
    } catch (error) {
      console.error("Error sending cached video:", error);
      await chat.sendMessage("❌ Error: " + error.message);
    }
  }

  if (command == "!ytdl") {
    let filePath;
    let videoSentSuccessfully = false;

    try {
      const url = only_search[0];

      // Validate URL
      if (!url || (!url.includes("youtube.com") && !url.includes("youtu.be"))) {
        await chat.sendMessage(
          "❌ Please provide a valid YouTube URL.\nUsage: !ytdl <youtube_url>"
        );
        return;
      }

      await chat.sendMessage("⏳ Fetching video information...");

      // Get video info
      const videoInfo = await getYouTubeVideoInfo(url);
      const videoTitle = sanitizeFilename(videoInfo.title || "video");
      const filename = `${videoTitle}`;

      // Check if already cached (any extension)
      const cachedFiles = fs
        .readdirSync(TEMP_DIR)
        .filter(
          (f) =>
            f.startsWith(videoTitle) &&
            !f.includes(".part") &&
            !f.includes(".f")
        );
      const isCached =
        cachedFiles.length > 0 &&
        fs.statSync(path.join(TEMP_DIR, cachedFiles[0])).size > 0;

      if (!isCached) {
        await chat.sendMessage(
          `📹 Downloading: ${videoInfo.title}\n⏱️ This may take a while...`
        );
      } else {
        await chat.sendMessage(
          `📹 Found in cache: ${videoInfo.title}\n⚡ Sending immediately...`
        );
      }

      // Download video (returns cached if exists)
      filePath = await download_video(url, filename);

      console.log(`✓ Download complete: ${filePath}`);

      const stats = fs.statSync(filePath);
      const fileSizeMB = stats.size / 1024 / 1024;
      console.log(`✓ File verified: ${fileSizeMB.toFixed(2)} MB`);

      // WhatsApp allows files up to 2GB
      const MAX_FILE_SIZE_MB = 2000;
      if (fileSizeMB > MAX_FILE_SIZE_MB) {
        await chat.sendMessage(
          `❌ Video is too large (${fileSizeMB.toFixed(2)} MB).\n` +
            `WhatsApp limit is ${MAX_FILE_SIZE_MB} MB.\n` +
            `💡 Try a shorter video or use a YouTube Shorts link.`
        );
        return;
      }

      await chat.sendMessage(
        `✅ ${
          isCached ? "From cache" : "Download complete"
        }! (${fileSizeMB.toFixed(
          2
        )} MB)\n📤 Uploading to WhatsApp... (this may take a moment)`
      );

      // Send video file as document for reliability
      console.log("Creating MessageMedia from file...");
      const fileData = fs.readFileSync(filePath);
      const base64Data = fileData.toString("base64");

      // Get correct MIME type based on actual file extension
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".mov": "video/quicktime",
      };
      const mimeType = mimeTypes[ext] || "video/mp4";
      const outputFilename = `${videoTitle}${ext}`;

      console.log(`Sending as ${ext} (${mimeType})...`);

      const media = new MessageMedia(
        mimeType,
        base64Data,
        outputFilename,
        stats.size
      );

      console.log("Sending as document to WhatsApp...");
      // NOTE: Do NOT use sendAudioAsVoice: true here - it breaks video sending!
      await chat.sendMessage(media, {
        sendMediaAsDocument: true,
      });

      videoSentSuccessfully = true;
      await chat.sendMessage("✅ Video sent successfully!");
    } catch (error) {
      console.error("Error downloading/sending YouTube video:", error);
      await chat.sendMessage(
        `❌ Error: ${error.message}\n\n💡 Tip: File may be too large for WhatsApp (limit: 2GB).`
      );
    } finally {
      // Keep cached files for future requests - only clean up partial downloads
      try {
        const files = fs.readdirSync(TEMP_DIR);
        files.forEach((file) => {
          if (
            file.includes(".f140") ||
            file.includes(".f399") ||
            file.includes(".part") ||
            file.includes(".temp")
          ) {
            const partialPath = path.join(TEMP_DIR, file);
            fs.unlinkSync(partialPath);
            console.log(`Cleaned up partial file: ${file}`);
          }
        });
      } catch (e) {
        console.error("Error cleaning partial files:", e);
      }
    }
  }
});

client.initialize();
