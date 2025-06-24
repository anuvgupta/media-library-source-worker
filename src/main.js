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
        const videoExtensions = [".mp4", ".mkv", ".avi", ".mov", ".m4v"];
        return videoExtensions.includes(ext);
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
        await worker.login();

        const args = process.argv.slice(2);
        const command = args[0];

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
