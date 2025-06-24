#!/usr/bin/env node

// main.js
// Worker script for uploading media to S3 using Cognito authentication

const {
    CognitoIdentityProviderClient,
    InitiateAuthCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const {
    CognitoIdentityClient,
    GetIdCommand,
    GetCredentialsForIdentityCommand,
} = require("@aws-sdk/client-cognito-identity");
const {
    S3Client,
    PutObjectCommand,
    ListObjectsV2Command,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { promisify } = require("util");

const { VideoHLSUploader } = require("./VideoHLSUploader/index.js");

// Configuration
const CONFIG_FILE = path.join(__dirname, "../config/dev.json");
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));

// Token storage file
const TOKEN_FILE = path.join(__dirname, "../.worker-tokens.json");

class MediaWorker {
    constructor() {
        this.cognitoIdentityProvider = new CognitoIdentityProviderClient({
            region: CONFIG.region,
        });
        this.cognitoIdentity = new CognitoIdentityClient({
            region: CONFIG.region,
        });
        this.s3 = null; // Will be initialized after authentication
        this.tokens = this.loadTokens();
        this.credentials = null;
        this.hlsUploader = null; // Will be initialized after S3 client is ready
    }

    // Initialize HLS uploader after S3 client is ready
    initializeHLSUploader() {
        if (!this.s3 || !this.credentials?.identityId) {
            throw new Error(
                "S3 client and credentials must be initialized first"
            );
        }

        this.hlsUploader = new VideoHLSUploader({
            s3Client: this.s3,
            mediaBucketName: CONFIG.mediaBucketName,
            playlistBucketName: CONFIG.playlistBucketName,
            mediaUploadPath: CONFIG.mediaUploadPath,
            playlistUploadPath: CONFIG.playlistUploadPath,
            websiteDomain: CONFIG.websiteDomain || "your-domain.com",
            segmentDuration: 10,
            concurrentUploads: 3,
            prioritySegments: 5,
            tempDir: "./temp",
        });

        console.log("✅ HLS Uploader initialized");
    }

    // Load stored tokens from file
    loadTokens() {
        try {
            if (fs.existsSync(TOKEN_FILE)) {
                const data = fs.readFileSync(TOKEN_FILE, "utf8");
                return JSON.parse(data);
            }
        } catch (error) {
            console.warn("Could not load stored tokens:", error.message);
        }
        return null;
    }

    // Save tokens to file
    saveTokens(tokens) {
        try {
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
            console.log("Tokens saved successfully");
        } catch (error) {
            console.error("Failed to save tokens:", error.message);
        }
    }

    // Get user input securely
    async getInput(prompt, hidden = false) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        return new Promise((resolve) => {
            if (hidden) {
                const stdin = process.openStdin();
                process.stdout.write(prompt);
                stdin.setRawMode(true);
                stdin.resume();
                stdin.setEncoding("utf8");
                let password = "";
                stdin.on("data", (ch) => {
                    ch = ch + "";
                    switch (ch) {
                        case "\n":
                        case "\r":
                        case "\u0004":
                            stdin.setRawMode(false);
                            stdin.pause();
                            console.log("");
                            resolve(password);
                            break;
                        case "\u0003":
                            process.exit();
                            break;
                        default:
                            password += ch;
                            process.stdout.write("*");
                            break;
                    }
                });
            } else {
                rl.question(prompt, (answer) => {
                    rl.close();
                    resolve(answer);
                });
            }
        });
    }

    // Authenticate with username/password
    async authenticate(username, password) {
        try {
            console.log("Authenticating...");

            const command = new InitiateAuthCommand({
                AuthFlow: "USER_PASSWORD_AUTH",
                ClientId: CONFIG.clientId,
                AuthParameters: {
                    USERNAME: username,
                    PASSWORD: password,
                },
            });

            const authResult = await this.cognitoIdentityProvider.send(command);

            if (authResult.ChallengeName) {
                throw new Error(
                    `Authentication challenge required: ${authResult.ChallengeName}`
                );
            }

            const tokens = {
                accessToken: authResult.AuthenticationResult.AccessToken,
                idToken: authResult.AuthenticationResult.IdToken,
                refreshToken: authResult.AuthenticationResult.RefreshToken,
                expiresAt:
                    Date.now() +
                    authResult.AuthenticationResult.ExpiresIn * 1000,
                username: username,
            };

            this.tokens = tokens;
            this.saveTokens(tokens);

            console.log("Authentication successful!");
            return tokens;
        } catch (error) {
            console.error("Authentication failed:", error.message);
            throw error;
        }
    }

    // Refresh access token using refresh token
    async refreshTokens() {
        if (!this.tokens?.refreshToken) {
            throw new Error("No refresh token available");
        }

        try {
            console.log("Refreshing tokens...");

            const command = new InitiateAuthCommand({
                AuthFlow: "REFRESH_TOKEN_AUTH",
                ClientId: CONFIG.clientId,
                AuthParameters: {
                    REFRESH_TOKEN: this.tokens.refreshToken,
                },
            });

            const refreshResult = await this.cognitoIdentityProvider.send(
                command
            );

            const newTokens = {
                ...this.tokens,
                accessToken: refreshResult.AuthenticationResult.AccessToken,
                idToken: refreshResult.AuthenticationResult.IdToken,
                expiresAt:
                    Date.now() +
                    refreshResult.AuthenticationResult.ExpiresIn * 1000,
            };

            // Update refresh token if a new one was provided
            if (refreshResult.AuthenticationResult.RefreshToken) {
                newTokens.refreshToken =
                    refreshResult.AuthenticationResult.RefreshToken;
            }

            this.tokens = newTokens;
            this.saveTokens(newTokens);

            console.log("Tokens refreshed successfully!");
            return newTokens;
        } catch (error) {
            console.error("Token refresh failed:", error.message);
            throw error;
        }
    }

    // Check if tokens are valid and refresh if needed
    async ensureValidTokens() {
        if (!this.tokens) {
            return false;
        }

        // Check if access token is expired (with 5 minute buffer)
        const fiveMinutes = 5 * 60 * 1000;
        if (Date.now() + fiveMinutes >= this.tokens.expiresAt) {
            try {
                await this.refreshTokens();
                return true;
            } catch (error) {
                console.log("Token refresh failed, need to re-authenticate");
                return false;
            }
        }

        return true;
    }

    // Get AWS credentials using Cognito Identity
    async getAWSCredentials() {
        if (!this.tokens?.idToken) {
            throw new Error("No ID token available");
        }

        try {
            console.log("Getting AWS credentials...");

            // Get identity ID
            const getIdCommand = new GetIdCommand({
                IdentityPoolId: CONFIG.identityPoolId,
                Logins: {
                    [`cognito-idp.${CONFIG.region}.amazonaws.com/${CONFIG.userPoolId}`]:
                        this.tokens.idToken,
                },
            });

            const identityResult = await this.cognitoIdentity.send(
                getIdCommand
            );
            const identityId = identityResult.IdentityId;

            // Get credentials for the identity
            const getCredentialsCommand = new GetCredentialsForIdentityCommand({
                IdentityId: identityId,
                Logins: {
                    [`cognito-idp.${CONFIG.region}.amazonaws.com/${CONFIG.userPoolId}`]:
                        this.tokens.idToken,
                },
            });

            const credentialsResult = await this.cognitoIdentity.send(
                getCredentialsCommand
            );

            const credentials = {
                accessKeyId: credentialsResult.Credentials.AccessKeyId,
                secretAccessKey: credentialsResult.Credentials.SecretKey,
                sessionToken: credentialsResult.Credentials.SessionToken,
                identityId: identityId,
            };

            this.credentials = credentials;

            // Initialize S3 client with the credentials
            this.s3 = new S3Client({
                region: CONFIG.region,
                credentials: {
                    accessKeyId: credentials.accessKeyId,
                    secretAccessKey: credentials.secretAccessKey,
                    sessionToken: credentials.sessionToken,
                },
            });

            // Initialize HLS uploader after S3 client is ready
            this.initializeHLSUploader();

            console.log("AWS credentials obtained successfully!");
            console.log("Identity ID:", identityId);

            return credentials;
        } catch (error) {
            console.error("Failed to get AWS credentials:", error.message);
            throw error;
        }
    }

    // Upload file to S3 directly (for non-video files)
    async uploadFile(filePath, bucketName, key) {
        if (!this.s3) {
            throw new Error(
                "S3 client not initialized. Call getAWSCredentials() first."
            );
        }

        try {
            console.log(`Uploading ${filePath} to s3://${bucketName}/${key}`);

            const fileContent = fs.readFileSync(filePath);

            // For larger files, use the multipart upload
            const upload = new Upload({
                client: this.s3,
                params: {
                    Bucket: bucketName,
                    Key: key,
                    Body: fileContent,
                    ContentType: this.getContentType(filePath),
                },
            });

            // Optional: track upload progress
            upload.on("httpUploadProgress", (progress) => {
                if (progress.total) {
                    const percentage = Math.round(
                        (progress.loaded / progress.total) * 100
                    );
                    console.log(`Upload progress: ${percentage}%`);
                }
            });

            const result = await upload.done();
            console.log("Upload successful:", result.Location);
            return result;
        } catch (error) {
            console.error("Upload failed:", error.message);
            throw error;
        }
    }

    // Get content type based on file extension
    getContentType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const contentTypes = {
            ".mp4": "video/mp4",
            ".mkv": "video/x-matroska",
            ".avi": "video/x-msvideo",
            ".mov": "video/quicktime",
            ".mp3": "audio/mpeg",
            ".flac": "audio/flac",
            ".wav": "audio/wav",
            ".m3u8": "application/vnd.apple.mpegurl",
            ".ts": "video/mp2t",
            ".json": "application/json",
        };
        return contentTypes[ext] || "application/octet-stream";
    }

    // Check if file is a video that should use HLS upload
    isVideoFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const videoExtensions = [
            ".mp4",
            ".mkv",
            ".avi",
            ".mov",
            ".m4v",
            ".wmv",
            ".flv",
            ".webm",
        ];
        return videoExtensions.includes(ext);
    }

    // Check if ffprobe is available
    async checkFFprobeAvailable() {
        return new Promise((resolve) => {
            const ffprobe = spawn("ffprobe", ["-version"]);
            ffprobe.on("close", (code) => {
                resolve(code === 0);
            });
            ffprobe.on("error", () => {
                resolve(false);
            });
        });
    }

    // Get video metadata using ffprobe
    async getVideoMetadata(filePath) {
        return new Promise((resolve, reject) => {
            console.log(
                `        Running ffprobe on: ${path.basename(filePath)}`
            );

            const ffprobe = spawn("ffprobe", [
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                filePath,
            ]);

            let stdout = "";
            let stderr = "";

            ffprobe.stdout.on("data", (data) => {
                stdout += data;
            });

            ffprobe.stderr.on("data", (data) => {
                stderr += data;
            });

            ffprobe.on("close", (code) => {
                if (code === 0) {
                    try {
                        const metadata = JSON.parse(stdout);
                        console.log(
                            `        ffprobe successful for ${path.basename(
                                filePath
                            )}`
                        );
                        resolve(metadata);
                    } catch (error) {
                        reject(
                            new Error(
                                `Failed to parse ffprobe output: ${error.message}`
                            )
                        );
                    }
                } else {
                    reject(
                        new Error(`ffprobe failed with code ${code}: ${stderr}`)
                    );
                }
            });

            ffprobe.on("error", (error) => {
                reject(new Error(`Failed to run ffprobe: ${error.message}`));
            });
        });
    }

    // Extract quality from filename if ffprobe fails
    extractQualityFromFilename(filename) {
        const name = filename.toLowerCase();
        if (
            name.includes("2160p") ||
            name.includes("4k") ||
            name.includes("uhd")
        )
            return "4K";
        if (name.includes("1440p")) return "1440p";
        if (name.includes("1080p") || name.includes("fhd")) return "1080p";
        if (name.includes("720p") || name.includes("hd")) return "720p";
        if (name.includes("480p")) return "480p";
        if (name.includes("360p")) return "360p";
        return "Unknown";
    }

    // Extract quality from video metadata
    extractQuality(streams) {
        const videoStream = streams.find(
            (stream) => stream.codec_type === "video"
        );
        if (!videoStream) {
            return "Unknown";
        }

        const height = videoStream.height;
        if (height >= 2160) return "4K";
        if (height >= 1440) return "1440p";
        if (height >= 1080) return "1080p";
        if (height >= 720) return "720p";
        if (height >= 480) return "480p";
        return `${height}p`;
    }

    // Format file size to human readable format
    formatFileSize(bytes) {
        const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
        if (bytes === 0) return "0 Bytes";
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (
            Math.round((bytes / Math.pow(1024, i)) * 100) / 100 + " " + sizes[i]
        );
    }

    // Format runtime from seconds to readable format
    formatRuntime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }

    // Parse movie name and year from folder name
    parseMovieNameAndYear(folderName) {
        // Match pattern: "Movie Name (YYYY)"
        const match = folderName.match(/^(.+?)\s*\((\d{4})\)$/);
        if (match) {
            return {
                name: match[1].trim(),
                year: parseInt(match[2]),
            };
        }

        // Fallback: return the folder name as-is and null year
        return {
            name: folderName,
            year: null,
        };
    }

    // Scan library for movie collections and metadata
    async scanLibrary(libraryPath) {
        console.log(`Scanning library at: ${libraryPath}`);

        if (!fs.existsSync(libraryPath)) {
            throw new Error(`Library path does not exist: ${libraryPath}`);
        }

        // Check if ffprobe is available
        const ffprobeAvailable = await this.checkFFprobeAvailable();
        if (!ffprobeAvailable) {
            console.log(
                "⚠️  ffprobe not found - will extract basic info from filenames only"
            );
        } else {
            console.log("✅ ffprobe found - will extract detailed metadata");
        }

        const collections = {};

        try {
            // Get all collection folders (first level subfolders)
            const collectionFolders = fs
                .readdirSync(libraryPath, { withFileTypes: true })
                .filter((dirent) => dirent.isDirectory())
                .map((dirent) => dirent.name);

            console.log(`Found ${collectionFolders.length} collections`);

            for (const collectionName of collectionFolders) {
                console.log(`\nScanning collection: ${collectionName}`);
                const collectionPath = path.join(libraryPath, collectionName);
                collections[collectionName] = [];

                // Get all movie folders (second level subfolders)
                const movieFolders = fs
                    .readdirSync(collectionPath, { withFileTypes: true })
                    .filter((dirent) => dirent.isDirectory())
                    .map((dirent) => dirent.name);

                console.log(
                    `  Found ${movieFolders.length} movies in ${collectionName}`
                );

                for (const movieFolderName of movieFolders) {
                    const moviePath = path.join(
                        collectionPath,
                        movieFolderName
                    );
                    const { name, year } =
                        this.parseMovieNameAndYear(movieFolderName);

                    console.log(
                        `    Processing: ${name} (${year || "Unknown Year"})`
                    );

                    try {
                        // Find video files in the movie folder
                        const files = fs
                            .readdirSync(moviePath, { withFileTypes: true })
                            .filter((dirent) => dirent.isFile())
                            .map((dirent) => dirent.name);

                        let videoFile = null;
                        let videoFilePath = null;

                        // Look for video files
                        for (const fileName of files) {
                            const filePath = path.join(moviePath, fileName);
                            if (this.isVideoFile(filePath)) {
                                videoFile = fileName;
                                videoFilePath = filePath;
                                break; // Use the first video file found
                            }
                        }

                        if (!videoFile) {
                            console.log(
                                `      Warning: No video file found in ${movieFolderName}`
                            );
                            collections[collectionName].push({
                                name,
                                year,
                                runtime: "Unknown",
                                fileSize: "Unknown",
                                quality: "Unknown",
                                error: "No video file found",
                            });
                            continue;
                        }

                        console.log(`      Found video file: ${videoFile}`);

                        // Get file size
                        const stats = fs.statSync(videoFilePath);
                        const fileSize = this.formatFileSize(stats.size);

                        // Initialize metadata
                        let runtime = "Unknown";
                        let quality = "Unknown";

                        // Try to get metadata using ffprobe if available
                        if (ffprobeAvailable) {
                            try {
                                const metadata = await this.getVideoMetadata(
                                    videoFilePath
                                );

                                // Extract runtime
                                if (
                                    metadata.format &&
                                    metadata.format.duration
                                ) {
                                    const durationSeconds = parseFloat(
                                        metadata.format.duration
                                    );
                                    runtime =
                                        this.formatRuntime(durationSeconds);
                                    console.log(`        Duration: ${runtime}`);
                                }

                                // Extract quality
                                if (metadata.streams) {
                                    quality = this.extractQuality(
                                        metadata.streams
                                    );
                                    console.log(`        Quality: ${quality}`);
                                }
                            } catch (metadataError) {
                                console.log(
                                    `        ffprobe failed: ${metadataError.message}`
                                );
                                console.log(
                                    `        Falling back to filename-based quality detection`
                                );
                                quality =
                                    this.extractQualityFromFilename(videoFile);
                            }
                        } else {
                            // Fallback to filename-based quality detection
                            quality =
                                this.extractQualityFromFilename(videoFile);
                            console.log(
                                `        Quality (from filename): ${quality}`
                            );
                        }

                        console.log(
                            `      Final metadata: ${runtime}, ${quality}, ${fileSize}`
                        );

                        // Add movie to collection
                        collections[collectionName].push({
                            name,
                            year,
                            runtime,
                            fileSize,
                            quality,
                            videoFile,
                            path: videoFilePath,
                        });
                    } catch (movieError) {
                        console.log(
                            `      Error processing ${movieFolderName}: ${movieError.message}`
                        );
                        collections[collectionName].push({
                            name,
                            year,
                            runtime: "Unknown",
                            fileSize: "Unknown",
                            quality: "Unknown",
                            error: movieError.message,
                        });
                    }
                }
            }

            console.log(
                `\nLibrary scan complete. Found ${
                    Object.keys(collections).length
                } collections with ${Object.values(collections).reduce(
                    (total, movies) => total + movies.length,
                    0
                )} movies total.`
            );
            return collections;
        } catch (error) {
            console.error(`Error scanning library: ${error.message}`);
            throw error;
        }
    }

    // Main authentication flow
    async login() {
        // Check if we have valid stored tokens
        if (await this.ensureValidTokens()) {
            console.log("Using stored authentication tokens");
            await this.getAWSCredentials();
            return;
        }

        // Need to authenticate
        console.log("Authentication required");
        const username = await this.getInput("Username: ");
        const password = await this.getInput("Password: ", true);

        await this.authenticate(username, password);
        await this.getAWSCredentials();
    }

    // Upload media file with HLS conversion for videos
    async uploadMedia(filePath) {
        if (!this.credentials?.identityId) {
            throw new Error("Not authenticated");
        }

        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        // Check if it's a video file that should use HLS
        if (this.isVideoFile(filePath)) {
            if (!this.hlsUploader) {
                throw new Error("HLS uploader not initialized");
            }

            console.log(`Starting HLS upload for video: ${filePath}`);

            // Set the upload paths for the user's folder
            const ownerId = this.credentials.identityId;
            const uploadSubpath = ownerId;
            const fileName = path.basename(filePath, path.extname(filePath));
            const movieId = fileName;

            try {
                const uploadSession = await this.hlsUploader.uploadMovie(
                    filePath,
                    movieId,
                    uploadSubpath
                );
                console.log(`✅ HLS upload completed for movie: ${movieId}`);
                return uploadSession;
            } catch (error) {
                console.error(`❌ HLS upload failed:`, error);
                throw error;
            }
        } else {
            // For non-video files, use direct S3 upload
            console.log(`Uploading non-video file: ${filePath}`);
            const ownerId = this.credentials.identityId;
            const fileName = path.basename(filePath);
            const key = `media/${ownerId}/files/${fileName}`;

            return await this.uploadFile(filePath, CONFIG.mediaBucketName, key);
        }
    }

    // List files in user's folder
    async listFiles(bucketName) {
        if (!this.s3 || !this.credentials?.identityId) {
            throw new Error("Not authenticated");
        }

        try {
            const command = new ListObjectsV2Command({
                Bucket: bucketName,
                Prefix: `media/${this.credentials.identityId}/`,
            });

            const result = await this.s3.send(command);
            return result.Contents || [];
        } catch (error) {
            console.error("Failed to list files:", error.message);
            throw error;
        }
    }

    // Check FFmpeg availability
    async checkFFmpeg() {
        if (!this.hlsUploader) {
            throw new Error("HLS uploader not initialized");
        }

        try {
            // Access the method through the uploader instance
            // Note: This assumes the checkFFmpeg method is accessible
            // If it's not, we might need to implement our own check
            const { spawn } = require("child_process");

            return new Promise((resolve, reject) => {
                const ffmpeg = spawn("ffmpeg", ["-version"]);

                ffmpeg.on("close", (code) => {
                    if (code === 0) {
                        const ffprobe = spawn("ffprobe", ["-version"]);

                        ffprobe.on("close", (probeCode) => {
                            if (probeCode === 0) {
                                console.log(
                                    "✅ FFmpeg and FFprobe are available"
                                );
                                resolve();
                            } else {
                                reject(
                                    new Error(
                                        "FFprobe not found. Please install FFmpeg package."
                                    )
                                );
                            }
                        });

                        ffprobe.on("error", () => {
                            reject(
                                new Error(
                                    "FFprobe not found. Please install FFmpeg package."
                                )
                            );
                        });
                    } else {
                        reject(
                            new Error(
                                "FFmpeg not found. Please install FFmpeg."
                            )
                        );
                    }
                });

                ffmpeg.on("error", () => {
                    reject(
                        new Error("FFmpeg not found. Please install FFmpeg.")
                    );
                });
            });
        } catch (error) {
            throw new Error(`FFmpeg check failed: ${error.message}`);
        }
    }
}

// CLI interface
async function main() {
    const worker = new MediaWorker();

    try {
        const args = process.argv.slice(2);
        const command = args[0];

        // For all other commands, authenticate first
        await worker.login();

        switch (command) {
            case "upload-media":
                if (!args[1]) {
                    console.error("Please provide file path");
                    process.exit(1);
                }
                await worker.uploadMedia(args[1]);
                break;

            case "list-media":
                const mediaFiles = await worker.listFiles(
                    CONFIG.mediaBucketName
                );
                console.log("Media files:");
                mediaFiles.forEach((file) => console.log(`  ${file.Key}`));
                break;

            case "list-playlists":
                const playlistFiles = await worker.listFiles(
                    CONFIG.playlistBucketName
                );
                console.log("Playlist files:");
                playlistFiles.forEach((file) => console.log(`  ${file.Key}`));
                break;

            case "check-ffmpeg":
                await worker.checkFFmpeg();
                break;

            case "status":
                console.log("Worker authenticated successfully!");
                console.log("Identity ID:", worker.credentials?.identityId);
                console.log("Username:", worker.tokens?.username);
                console.log(
                    "Token expires:",
                    new Date(worker.tokens?.expiresAt)
                );
                console.log(
                    "HLS Uploader:",
                    worker.hlsUploader ? "✅ Ready" : "❌ Not initialized"
                );
                break;

            case "scan-library":
                if (!args[1]) {
                    console.error("Please provide library path");
                    process.exit(1);
                }
                const libraryData = await worker.scanLibrary(args[1]);

                // Option to save to file
                if (args[2] === "--save" && args[3]) {
                    fs.writeFileSync(
                        args[3],
                        JSON.stringify(libraryData, null, 2)
                    );
                    console.log(`Library data saved to: ${args[3]}`);
                } else {
                    console.log("\nLibrary scan results:");
                    console.log(JSON.stringify(libraryData, null, 2));
                }
                break;

            default:
                console.log("Available commands:");
                console.log(
                    "  upload-media <file-path>    - Upload a media file (video files use HLS)"
                );
                console.log(
                    "  list-media                  - List uploaded media files"
                );
                console.log(
                    "  list-playlists              - List uploaded playlist files"
                );
                console.log(
                    "  check-ffmpeg                - Check if FFmpeg is available"
                );
                console.log(
                    "  scan-library <path> [--save <output-file>] - Scan movie library and extract metadata"
                );
                console.log(
                    "  status                      - Show authentication status"
                );
                break;
        }
    } catch (error) {
        console.error("Error:", error.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = MediaWorker;
