#!/usr/bin/env node

// main.js
// Worker script for uploading media to S3 using Cognito authentication

const fs = require("fs");
const path = require("path");
const https = require("https");
const readline = require("readline");
const { spawn } = require("child_process");
const { promisify } = require("util");
const { randomUUID } = require("crypto");

const aws4 = require("aws4");
const {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
} = require("@aws-sdk/client-sqs");
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
const {
    CloudFrontClient,
    CreateInvalidationCommand,
} = require("@aws-sdk/client-cloudfront");

const { VideoHLSUploader } = require("./VideoHLSUploader/index.js");
const { utf8ToBase64, base64ToUtf8 } = require("./util.js");

// Configuration
const STAGE = process.env.STAGE;
const IS_PROD = process.env.STAGE === "prod";
const CONFIG_FILE_PATH = `../config/${STAGE}.json`;
const CONFIG_FILE = path.join(__dirname, CONFIG_FILE_PATH);
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const LIBRARY_PATH = process.env.LIBRARY_PATH
    ? process.env.LIBRARY_PATH
    : CONFIG.libraryPath;

// Token storage file
const TOKEN_FILE = path.join(__dirname, "../.worker-tokens.json");

// Media worker monolith class
class MediaWorker {
    constructor() {
        this.cognitoIdentityProvider = new CognitoIdentityProviderClient({
            region: CONFIG.region,
        });
        this.cognitoIdentity = new CognitoIdentityClient({
            region: CONFIG.region,
        });
        this.s3 = null; // Will be initialized after authentication
        this.sqs = null; // Will be initialized after authentication
        // this.dynamodb = null; // Will be initialized after authentication
        this.cloudfront = null;
        this.hlsUploader = null; // Will be initialized after S3 client is ready
        this.tokens = this.loadTokens();
        this.credentials = null;
        this.isWorkerRunning = false;
        this.pollingErrorRetry = 0;
        this.pollingErrorRetryLimit = 3;
        this.maxConcurrentUploads = CONFIG.maxConcurrentUploads || 3;
        this.activeUploads = new Map(); // Track active uploads
        this.uploadQueue = []; // Queue for pending uploads
        this.processingUploads = 0; // Current number of processing uploads
        this.posterDownloadQueue = [];
        this.isProcessingPosters = false;
        this.tmdbApiDelay = 500; // 500ms between API calls to be respectful
        this.posterProcessingConcurrency = 2; // Process 2 posters at a time
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
            moviePreSignedUrlExpiration: CONFIG.moviePreSignedUrlExpiration,
            websiteDomain: CONFIG.websiteDomain || "your-domain.com",
            segmentDuration: 20,
            concurrentUploads: CONFIG.concurrentUploads,
            prioritySegments: CONFIG.prioritySegments,
            tempDir: "./temp",
            skipExistingSegments: true,
            makeAuthenticatedAPIRequest:
                this.makeAuthenticatedAPIRequest.bind(this),
        });

        console.log("✅ HLS Uploader initialized");
    }

    // Start worker mode - polls SQS indefinitely
    async startWorkerMode() {
        this.isWorkerRunning = true;
        console.log("🚀 Worker started");

        while (this.isWorkerRunning) {
            try {
                await this.pollSQS();
                await new Promise((resolve) =>
                    setTimeout(resolve, CONFIG.sqsPollingInterval)
                );
            } catch (error) {
                this.pollingErrorRetry += 1;
                console.error("Worker polling error:", error.message);
                if (this.pollingErrorRetry > this.pollingErrorRetryLimit) {
                    this.pollingErrorRetry = 0;
                    console.error("Attempting login");
                    await this.login();
                } else {
                    console.error("Retrying polling");
                    // Continue polling even if there's an error
                    await new Promise((resolve) =>
                        setTimeout(resolve, CONFIG.sqsPollingInterval)
                    );
                }
            }
        }
    }

    // Stop worker mode
    stopWorkerMode() {
        console.log("🛑 Stopping worker mode...");
        console.log(
            `⏳ Waiting for ${this.processingUploads} active uploads to complete...`
        );

        this.isWorkerRunning = false;

        // You might want to add a graceful shutdown that waits for uploads
        // For now, uploads will continue in the background
        if (this.processingUploads > 0) {
            console.log(
                "💡 Tip: Active uploads will continue. Monitor logs for completion."
            );
        }
    }

    // Poll SQS for messages
    async pollSQS() {
        const command = new ReceiveMessageCommand({
            QueueUrl: CONFIG.sqsQueueUrl,
            MaxNumberOfMessages: CONFIG.maxReceiveCount,
            WaitTimeSeconds: 10, // Long polling
            MessageAttributeNames: ["All"],
        });

        const result = await this.sqs.send(command);

        if (result.Messages && result.Messages.length > 0) {
            // Process all messages concurrently (but uploads will be controlled)
            const messagePromises = result.Messages.map((message) =>
                this.processMessage(message).catch((error) => {
                    console.error(
                        `Error processing message ${message.MessageId}:`,
                        error.message
                    );
                    // Don't rethrow - we want to continue processing other messages
                })
            );

            await Promise.all(messagePromises);
        }
    }

    // Process individual SQS message
    async processMessage(message) {
        try {
            const body = JSON.parse(message.Body);
            const identityId = body.identityId;

            if (identityId != this.getIdentityId()) {
                return;
            }

            console.log(`Processing message: ${message.MessageId}`);
            const command = body.command;

            switch (command) {
                case "refresh-library":
                    await this.handleRefreshLibrary(body);
                    break;

                case "upload-movie":
                    // Handle upload-movie asynchronously
                    await this.queueUploadMovie(body, message);
                    return; // Don't delete message yet - will be deleted after upload

                default:
                    console.log(`Unknown command: ${command}`);
                    break;
            }

            // Delete message after successful processing (for non-upload commands)
            await this.deleteMessage(message.ReceiptHandle);
            console.log(
                `✅ Message processed and deleted: ${message.MessageId}`
            );
        } catch (error) {
            console.error(
                `❌ Error processing message ${message.MessageId}:`,
                error.message
            );
            // Message will remain in queue and be retried
        }
    }

    // Handle refresh-library command
    async handleRefreshLibrary(messageBody) {
        console.log("🔄 Handling refresh-library command");

        const libraryPath = LIBRARY_PATH; // Use from config/env
        const outputFile = `${libraryPath}/media-library.json`;

        const libraryData = await this.scanLibrary(libraryPath);

        if (outputFile) {
            fs.writeFileSync(outputFile, JSON.stringify(libraryData, null, 2));
            console.log(`Library data saved to: ${outputFile}`);
        }

        // Upload to S3
        try {
            if (!this.credentials?.identityId) {
                throw new Error("Not authenticated - cannot upload to S3");
            }

            const s3Key = `${
                CONFIG.libraryUploadPath
            }/${this.getIdentityId()}/library.json`;
            const jsonContent = JSON.stringify(libraryData, null, 2);

            console.log(
                `📤 Uploading library data to S3: s3://${CONFIG.libraryBucketName}/${s3Key}`
            );

            const upload = new Upload({
                client: this.s3,
                params: {
                    Bucket: CONFIG.libraryBucketName,
                    Key: s3Key,
                    Body: jsonContent,
                    ContentType: "application/json",
                },
            });

            const uploadResult = await upload.done();
            console.log(
                `✅ Library data uploaded successfully to: ${uploadResult.Location}`
            );

            // Log some stats about what was uploaded
            const movieCount = Object.values(libraryData).reduce(
                (total, movies) => total + movies.length,
                0
            );
            const collectionCount = Object.keys(libraryData).length;
            console.log(
                `📊 Uploaded library contains ${movieCount} movies across ${collectionCount} collections`
            );

            // Create or update DynamoDB record via API
            await this.updateLibraryAccessViaAPI(movieCount, collectionCount);
        } catch (s3Error) {
            console.error(
                `❌ Failed to upload library data to S3:`,
                s3Error.message
            );
            // Don't throw here - we still want to return the library data even if S3 upload fails
            console.log(
                "📝 Library scan completed successfully, but S3 upload failed"
            );
        }

        console.log("✅ Library refresh completed");

        // Start poster processing in background (non-blocking)
        this.processMoviePosters(libraryData).catch((error) => {
            console.warn(
                "Poster processing failed (non-critical):",
                error.message
            );
        });

        return libraryData;
    }

    // Method to update library access via API
    async updateLibraryAccessViaAPI(movieCount, collectionCount) {
        if (!this.credentials?.identityId) {
            throw new Error("Authentication credentials not available");
        }

        try {
            console.log("📝 Updating LibraryAccess record via API...");

            const ownerIdentityId = this.getIdentityId();
            const currentTime = new Date().toISOString();

            // Prepare the request body
            const requestBody = {
                movieCount: movieCount,
                collectionCount: collectionCount,
                lastScanAt: currentTime,
            };

            // Make API call to update library access
            const apiEndpoint = `libraries/${ownerIdentityId}/access`;

            const response = await this.makeAuthenticatedAPIRequest(
                "POST",
                apiEndpoint,
                requestBody
            );

            if (response.ok) {
                const result = await response.json();
                console.log(
                    `✅ LibraryAccess record updated successfully via API`
                );
                console.log(
                    `📊 Record contains ${movieCount} movies across ${collectionCount} collections`
                );
            } else {
                const errorText = await response.text();
                throw new Error(
                    `API request failed: ${response.status} ${errorText}`
                );
            }
        } catch (error) {
            console.error(
                "❌ Failed to update LibraryAccess record via API:",
                error.message
            );
            // Don't throw here - the library refresh was successful even if API update fails
            console.log(
                "⚠️  Library refresh completed successfully, but LibraryAccess update failed"
            );
        }
    }

    // Method to make authenticated API requests with AWS4 signing
    async makeAuthenticatedAPIRequest(method, endpoint, body) {
        try {
            const apiHost = CONFIG.apiDomain;
            const region = CONFIG.region;

            const requestOptions = {
                host: apiHost,
                method: method,
                path: `/${endpoint}`,
                service: "execute-api",
                region: region,
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            };

            // Sign the request with AWS4
            const signedRequest = aws4.sign(requestOptions, {
                accessKeyId: this.credentials.accessKeyId,
                secretAccessKey: this.credentials.secretAccessKey,
                sessionToken: this.credentials.sessionToken,
            });

            console.log(
                `Making API request to: https://${signedRequest.host}${signedRequest.path}`
            );

            // Make the request using Node.js https module
            return new Promise((resolve, reject) => {
                const req = https.request(
                    {
                        hostname: signedRequest.host,
                        port: 443,
                        path: signedRequest.path,
                        method: signedRequest.method,
                        headers: signedRequest.headers,
                    },
                    (res) => {
                        let data = "";

                        res.on("data", (chunk) => {
                            data += chunk;
                        });

                        res.on("end", () => {
                            // Create a response object similar to fetch API
                            const response = {
                                ok:
                                    res.statusCode >= 200 &&
                                    res.statusCode < 300,
                                status: res.statusCode,
                                statusText: res.statusMessage,
                                headers: res.headers,
                                json: async () => {
                                    try {
                                        return JSON.parse(data);
                                    } catch (e) {
                                        throw new Error(
                                            "Response is not valid JSON"
                                        );
                                    }
                                },
                                text: async () => data,
                            };
                            resolve(response);
                        });
                    }
                );

                req.on("error", (error) => {
                    reject(error);
                });

                // Write the request body
                if (signedRequest.body) {
                    req.write(signedRequest.body);
                }

                req.end();
            });
        } catch (error) {
            console.error("Error making authenticated API request:", error);
            throw error;
        }
    }

    // Handle upload-movie command
    async handleUploadMovie(messageBody) {
        console.log("🎬 Handling upload-movie command");
        const movieId = messageBody.movieId;

        if (!movieId) {
            throw new Error("movieId is required for upload-movie command");
        }

        // Check if upload is already in progress
        if (this.activeUploads.has(movieId)) {
            console.log(
                `🔄 Upload already in progress for movie: ${movieId}, discarding duplicate request`
            );
            return { status: "duplicate_request_discarded", movieId };
        }

        const libraryPath = LIBRARY_PATH; // Use from config/env
        const moviePathInLibrary = base64ToUtf8(messageBody.movieId);
        const moviePath = `${libraryPath}/${moviePathInLibrary}`;

        if (!fs.existsSync(moviePath)) {
            throw new Error(`Movie file not found: ${moviePath}`);
        }

        try {
            // Mark upload as active
            this.activeUploads.set(movieId, {
                status: "starting",
                startTime: Date.now(),
                moviePath: moviePath,
            });

            const uploadResult = await this.uploadMedia(moviePath, movieId);

            console.log(
                `✅ Movie upload completed: ${
                    movieId || path.basename(moviePath)
                }`
            );
            return uploadResult;
        } catch (error) {
            console.error(`❌ Movie upload failed: ${movieId}`, error);
            throw error;
        } finally {
            // Always clean up the active upload tracking
            this.activeUploads.delete(movieId);
        }
    }

    // Delete processed message from SQS
    async deleteMessage(receiptHandle) {
        const command = new DeleteMessageCommand({
            QueueUrl: CONFIG.sqsQueueUrl,
            ReceiptHandle: receiptHandle,
        });

        await this.sqs.send(command);
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
        if (hidden) {
            return new Promise((resolve, reject) => {
                process.stdout.write(prompt);

                // Set raw mode to capture each keypress
                process.stdin.setRawMode(true);
                process.stdin.resume();
                process.stdin.setEncoding("utf8");

                let password = "";

                const onData = (ch) => {
                    const charCode = ch.charCodeAt(0);

                    switch (charCode) {
                        case 13: // Enter key (\r)
                        case 10: // Enter key (\n)
                        case 4: // Ctrl+D
                            process.stdin.setRawMode(false);
                            process.stdin.pause();
                            process.stdin.removeListener("data", onData);
                            process.stdout.write("\n");
                            resolve(password);
                            break;
                        case 3: // Ctrl+C
                            process.stdin.setRawMode(false);
                            process.stdin.pause();
                            process.stdin.removeListener("data", onData);
                            process.stdout.write("\n");
                            process.exit(0);
                            break;
                        case 127: // Backspace/Delete
                        case 8: // Backspace
                            if (password.length > 0) {
                                password = password.slice(0, -1);
                                process.stdout.write("\b \b");
                            }
                            break;
                        default:
                            // Only add printable characters
                            if (charCode >= 32 && charCode <= 126) {
                                password += ch;
                                process.stdout.write("*");
                            }
                            break;
                    }
                };

                process.stdin.on("data", onData);

                // Handle process termination
                process.on("SIGINT", () => {
                    process.stdin.setRawMode(false);
                    process.stdin.pause();
                    process.stdin.removeListener("data", onData);
                    process.stdout.write("\n");
                    process.exit(0);
                });
            });
        } else {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            return new Promise((resolve) => {
                rl.question(prompt, (answer) => {
                    rl.close();
                    resolve(answer);
                });
            });
        }
    }

    // Add this method to decode JWT token and extract sub
    decodeJWT(token) {
        try {
            // JWT tokens have 3 parts separated by dots: header.payload.signature
            const parts = token.split(".");
            if (parts.length !== 3) {
                throw new Error("Invalid JWT token format");
            }

            // Decode the payload (second part)
            const payload = parts[1];
            // Add padding if needed for base64 decoding
            const paddedPayload =
                payload + "=".repeat((4 - (payload.length % 4)) % 4);
            const decodedPayload = Buffer.from(
                paddedPayload,
                "base64"
            ).toString("utf8");

            return JSON.parse(decodedPayload);
        } catch (error) {
            throw new Error(`Failed to decode JWT token: ${error.message}`);
        }
    }

    getUsername() {
        // First check if we have the username stored from authentication
        if (this.tokens?.username) {
            return this.tokens.username;
        }

        // If not stored directly, try to extract from the ID token
        if (this.tokens?.idToken) {
            try {
                const payload = this.decodeJWT(this.tokens.idToken);
                // Cognito typically stores username in 'cognito:username' or 'username' field
                return (
                    payload["cognito:username"] ||
                    payload.username ||
                    payload.email
                );
            } catch (error) {
                console.warn(
                    "Failed to extract username from token:",
                    error.message
                );
            }
        }

        // If we can't get username from tokens, return null or throw error
        throw new Error(
            "No username available - user not authenticated or username not found in token"
        );
    }

    getUserId() {
        if (!this.tokens?.idToken) {
            throw new Error("No ID token available - user not authenticated");
        }

        try {
            const payload = this.decodeJWT(this.tokens.idToken);
            return payload.sub; // This is the actual user ID from Cognito User Pool
        } catch (error) {
            console.error(
                "Failed to extract user ID from token:",
                error.message
            );
            // Fallback to identityId if token parsing fails
            if (this.credentials?.identityId) {
                console.warn("Using identityId as fallback for user ID");
                return this.credentials.identityId;
            }
            throw new Error("Unable to determine user ID");
        }
    }

    getIdentityId() {
        return this.credentials?.identityId ?? null;
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

            // Initialize SQS client with the credentials
            this.sqs = new SQSClient({
                region: CONFIG.region,
                credentials: {
                    accessKeyId: credentials.accessKeyId,
                    secretAccessKey: credentials.secretAccessKey,
                    sessionToken: credentials.sessionToken,
                },
            });

            // // Initialize DynamoDB client with the credentials
            // const dynamodbClient = new DynamoDBClient({
            //     region: CONFIG.region,
            //     credentials: {
            //         accessKeyId: credentials.accessKeyId,
            //         secretAccessKey: credentials.secretAccessKey,
            //         sessionToken: credentials.sessionToken,
            //     },
            // });
            // this.dynamodb = DynamoDBDocumentClient.from(dynamodbClient);

            this.cloudfront = new CloudFrontClient({
                region: "us-east-1", // CloudFront APIs are only available in us-east-1
                credentials: {
                    accessKeyId: credentials.accessKeyId,
                    secretAccessKey: credentials.secretAccessKey,
                    sessionToken: credentials.sessionToken,
                },
            });

            // Initialize HLS uploader after S3 client is ready
            this.initializeHLSUploader();

            console.log("AWS credentials obtained successfully!");
            console.log("Username:", this.getUsername());
            console.log("User ID:", this.getUserId());
            console.log("Identity ID:", identityId);

            return credentials;
        } catch (error) {
            console.error("Failed to get AWS credentials:", error.message);
            throw error;
        }
    }

    async invalidateCloudFrontCache(paths) {
        if (!this.cloudfront || !CONFIG.cloudfrontDistributionId) {
            console.warn(
                "CloudFront client not initialized or distribution ID not configured"
            );
            return;
        }

        try {
            console.log(
                `🔄 Invalidating CloudFront cache for ${paths.length} paths...`
            );

            const invalidationParams = {
                DistributionId: CONFIG.cloudfrontDistributionId,
                InvalidationBatch: {
                    Paths: {
                        Quantity: paths.length,
                        Items: paths,
                    },
                    CallerReference: `poster-upload-${Date.now()}-${Math.random()
                        .toString(36)
                        .substr(2, 9)}`,
                },
            };

            const command = new CreateInvalidationCommand(invalidationParams);
            const result = await this.cloudfront.send(command);

            console.log(
                `✅ CloudFront invalidation created: ${result.Invalidation.Id}`
            );
            console.log(`   Status: ${result.Invalidation.Status}`);

            return result;
        } catch (error) {
            console.error(
                "❌ Failed to create CloudFront invalidation:",
                error.message
            );
            // Don't throw - invalidation failure shouldn't break poster upload
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
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();

        // Skip macOS metadata files and other system files
        if (
            fileName.startsWith("._") ||
            fileName.startsWith(".DS_Store") ||
            fileName.startsWith("Thumbs.db") ||
            fileName.startsWith(".")
        ) {
            return false;
        }

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

        const width = videoStream.width || 0;
        const height = videoStream.height || 0;

        // For quality determination, use the larger dimension (usually width for widescreen content)
        // or use width as primary indicator with height as secondary

        // 4K/UHD detection (3840x2160 or similar)
        if (width >= 3840 || height >= 2160) {
            return "4K";
        }

        // 1440p/QHD detection (2560x1440 or similar)
        if (width >= 2560 || height >= 1440) {
            return "1440p";
        }

        // 1080p/FHD detection - key change here
        // Standard 1080p: 1920x1080
        // Cinematic 1080p: 1920x800, 1920x804, etc.
        // Ultra-wide 1080p: 2560x1080
        if (width >= 1920 || (height >= 1080 && width >= 1440)) {
            return "1080p";
        }

        // 720p/HD detection (1280x720 or similar)
        if (width >= 1280 || (height >= 720 && width >= 960)) {
            return "720p";
        }

        // 480p/SD detection
        if (width >= 640 || height >= 480) {
            return "480p";
        }

        // 360p detection
        if (width >= 480 || height >= 360) {
            return "360p";
        }

        // Return actual resolution for anything else
        return `${width}x${height}`;
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
                // console.log(`\nScanning collection: ${collectionName}`);
                const collectionPath = path.join(libraryPath, collectionName);
                collections[collectionName] = [];

                // Get all movie folders (second level subfolders)
                const movieFolders = fs
                    .readdirSync(collectionPath, { withFileTypes: true })
                    .filter((dirent) => dirent.isDirectory())
                    .map((dirent) => dirent.name);

                // console.log(
                //     `  Found ${movieFolders.length} movies in ${collectionName}`
                // );

                for (const movieFolderName of movieFolders) {
                    const moviePath = path.join(
                        collectionPath,
                        movieFolderName
                    );
                    const { name, year } =
                        this.parseMovieNameAndYear(movieFolderName);

                    // console.log(
                    //     `    Processing: ${name} (${year || "Unknown Year"})`
                    // );

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

                        // console.log(`      Found video file: ${videoFile}`);

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
                                    // console.log(`        Duration: ${runtime}`);
                                }

                                // Extract quality
                                if (metadata.streams) {
                                    quality = this.extractQuality(
                                        metadata.streams
                                    );
                                    // console.log(`        Quality: ${quality}`);
                                }
                            } catch (metadataError) {
                                console.log(
                                    `        ffprobe failed: ${metadataError.message}`
                                );
                                // console.log(
                                //     `        Falling back to filename-based quality detection`
                                // );
                                quality =
                                    this.extractQualityFromFilename(videoFile);
                            }
                        } else {
                            // Fallback to filename-based quality detection
                            quality =
                                this.extractQualityFromFilename(videoFile);
                            // console.log(
                            //     `        Quality (from filename): ${quality}`
                            // );
                        }

                        // console.log(
                        //     `      Final metadata: ${runtime}, ${quality}, ${fileSize}`
                        // );

                        // Add movie to collection
                        collections[collectionName].push({
                            name,
                            year,
                            runtime,
                            fileSize,
                            quality,
                            videoFile,
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
    async uploadMedia(filePath, fileId) {
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
            const uploadSubpath = this.getIdentityId();
            const fileName = path.basename(filePath, path.extname(filePath));

            try {
                const uploadSession = await this.hlsUploader.uploadMovie(
                    filePath,
                    fileId,
                    uploadSubpath
                );
                console.log(`✅ HLS upload completed for file: ${fileId}`);
                return uploadSession;
            } catch (error) {
                console.error(`❌ HLS upload failed:`, error);
                throw error;
            }
        } else {
            // For non-video files, use direct S3 upload
            console.log(`Uploading non-video file: ${filePath}`);
            const uploadSubpath = this.getIdentityId();
            const key = `${CONFIG.mediaUploadPath}/${uploadSubpath}/files/${fileId}`;

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
                Prefix: `${CONFIG.mediaUploadPath}/${this.credentials.identityId}/`,
            });

            const result = await this.s3.send(command);
            return result.Contents || [];
        } catch (error) {
            console.error("Failed to list files:", error.message);
            throw error;
        }
    }

    // New method to queue and manage concurrent uploads
    async queueUploadMovie(messageBody, message) {
        const movieId = messageBody.movieId;

        if (!movieId) {
            throw new Error("movieId is required for upload-movie command");
        }

        // Check if upload is already in progress or queued
        if (this.activeUploads.has(movieId)) {
            console.log(
                `🔄 Upload already in progress for movie: ${movieId}, discarding duplicate request`
            );
            await this.deleteMessage(message.ReceiptHandle);
            return;
        }

        // Add to active uploads tracking
        this.activeUploads.set(movieId, {
            status: "queued",
            queueTime: Date.now(),
            messageBody,
            message,
        });

        // If we're under the concurrency limit, start immediately
        if (this.processingUploads < this.maxConcurrentUploads) {
            this.startUpload(movieId);
        } else {
            // Add to queue
            this.uploadQueue.push(movieId);
            console.log(
                `📋 Movie ${movieId} queued for upload (${this.uploadQueue.length} in queue)`
            );
        }
    }

    // New method to start an upload
    async startUpload(movieId) {
        if (!this.activeUploads.has(movieId)) {
            console.error(`❌ Movie ${movieId} not found in active uploads`);
            return;
        }

        const uploadInfo = this.activeUploads.get(movieId);
        this.processingUploads++;

        console.log(
            `🚀 Starting upload for movie: ${movieId} (${this.processingUploads}/${this.maxConcurrentUploads} slots used)`
        );

        try {
            // Update status
            uploadInfo.status = "uploading";
            uploadInfo.startTime = Date.now();

            // Start the actual upload (don't await - run in background)
            this.handleUploadMovieAsync(
                movieId,
                uploadInfo.messageBody,
                uploadInfo.message
            )
                .then(() => {
                    console.log(`✅ Upload completed for movie: ${movieId}`);
                })
                .catch((error) => {
                    console.error(
                        `❌ Upload failed for movie: ${movieId}`,
                        error
                    );
                })
                .finally(() => {
                    // Cleanup and start next upload
                    this.finishUpload(movieId);
                });
        } catch (error) {
            console.error(
                `❌ Failed to start upload for movie: ${movieId}`,
                error
            );
            this.finishUpload(movieId);
        }
    }

    // New async upload handler
    async handleUploadMovieAsync(movieId, messageBody, message) {
        try {
            // Update status: Processing started
            await this.updateMovieUploadStatus(
                movieId,
                0,
                "starting",
                "Movie processing started"
            );

            const libraryPath = LIBRARY_PATH;
            const moviePathInLibrary = base64ToUtf8(messageBody.movieId);
            const moviePath = `${libraryPath}/${moviePathInLibrary}`;

            if (!fs.existsSync(moviePath)) {
                throw new Error(`Movie file not found: ${moviePath}`);
            }

            const uploadResult = await this.uploadMedia(moviePath, movieId);

            // Update status: Processing completed
            await this.updateMovieUploadStatus(
                movieId,
                100,
                "completed",
                "All processing completed"
            );

            // Delete SQS message after successful upload
            await this.deleteMessage(message.ReceiptHandle);
            console.log(`✅ Message deleted for completed upload: ${movieId}`);

            return uploadResult;
        } catch (error) {
            // Update status: Processing failed
            await this.updateMovieUploadStatus(
                movieId,
                0,
                "failed",
                `Processing failed: ${error.message}`
            );

            console.error(`❌ Upload failed for movie: ${movieId}`, error);
            // Don't delete message on failure - let it retry
            throw error;
        }
    }

    // New method to clean up after upload completion
    finishUpload(movieId) {
        // Remove from active uploads
        this.activeUploads.delete(movieId);
        this.processingUploads--;

        console.log(
            `🔄 Upload slot freed (${this.processingUploads}/${this.maxConcurrentUploads} slots used)`
        );

        // Start next upload from queue if available
        if (
            this.uploadQueue.length > 0 &&
            this.processingUploads < this.maxConcurrentUploads
        ) {
            const nextMovieId = this.uploadQueue.shift();
            console.log(
                `📤 Starting queued upload: ${nextMovieId} (${this.uploadQueue.length} remaining in queue)`
            );
            this.startUpload(nextMovieId);
        }
    }

    // New method to get upload status
    getUploadStatus() {
        const activeUploads = Array.from(this.activeUploads.entries()).map(
            ([movieId, info]) => ({
                movieId,
                status: info.status,
                queueTime: info.queueTime,
                startTime: info.startTime,
                duration: info.startTime ? Date.now() - info.startTime : null,
            })
        );

        return {
            processing: this.processingUploads,
            maxConcurrent: this.maxConcurrentUploads,
            queued: this.uploadQueue.length,
            activeUploads,
        };
    }

    // Enhanced status command
    async showStatus() {
        console.log("Worker authenticated successfully!");
        console.log("Identity ID:", this.credentials?.identityId);
        console.log("Username:", this.tokens?.username);
        console.log("Token expires:", new Date(this.tokens?.expiresAt));
        console.log(
            "HLS Uploader:",
            this.hlsUploader ? "✅ Ready" : "❌ Not initialized"
        );

        // Show upload status
        const uploadStatus = this.getUploadStatus();
        console.log("\n📊 Upload Status:");
        console.log(
            `  Processing: ${uploadStatus.processing}/${uploadStatus.maxConcurrent}`
        );
        console.log(`  Queued: ${uploadStatus.queued}`);

        if (uploadStatus.activeUploads.length > 0) {
            console.log("  Active uploads:");
            uploadStatus.activeUploads.forEach((upload) => {
                const duration = upload.duration
                    ? `${Math.round(upload.duration / 1000)}s`
                    : "N/A";
                console.log(
                    `    ${upload.movieId}: ${upload.status} (${duration})`
                );
            });
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

    // Method to update movie upload status via API
    async updateMovieUploadStatus(
        movieId,
        percentage,
        stageName,
        message = null,
        eta = null
    ) {
        if (!this.credentials?.identityId) {
            console.warn("Cannot update status - not authenticated");
            return;
        }

        try {
            const ownerIdentityId = this.getIdentityId();
            const apiEndpoint = `libraries/${ownerIdentityId}/movies/${movieId}/status`;

            const requestBody = {
                percentage,
                stageName,
                message,
                eta,
            };

            console.log("STATUS UPDATE:", requestBody);

            const response = await this.makeAuthenticatedAPIRequest(
                "POST",
                apiEndpoint,
                requestBody
            );

            if (!response.ok) {
                const errorText = await response.text();
                console.warn(
                    `Failed to update status: ${response.status} ${errorText}`
                );
            }
        } catch (error) {
            console.warn("Failed to update upload status:", error.message);
            // Don't throw - status updates shouldn't break the upload process
        }
    }

    async processMoviePosters(libraryData) {
        if (this.isProcessingPosters) {
            console.log("Poster processing already in progress, skipping");
            return;
        }

        this.isProcessingPosters = true;
        console.log("🎬 Starting poster processing...");

        const uploadedPosters = []; // Track uploaded posters

        try {
            const ownerIdentityId = this.getIdentityId();

            // Get existing posters from S3
            const existingPosters = await this.getExistingPosters(
                ownerIdentityId
            );
            console.log(`📋 Found ${existingPosters.size} existing posters`);

            // Flatten all movies and filter out those that already have posters
            const allMovies = [];
            Object.keys(libraryData).forEach((collection) => {
                libraryData[collection].forEach((movie) => {
                    const movieId = utf8ToBase64(
                        `${collection}/${movie.name} (${movie.year})/${movie.videoFile}`
                    );
                    if (!existingPosters.has(movieId)) {
                        allMovies.push({
                            ...movie,
                            collection,
                            movieId,
                        });
                    }
                });
            });

            console.log(
                `🎬 Processing posters for ${allMovies.length} movies (${existingPosters.size} already cached)`
            );

            if (allMovies.length === 0) {
                console.log("✅ All movie posters already cached");
                return;
            }

            // Process movies in batches
            const batchSize = this.posterProcessingConcurrency;
            for (let i = 0; i < allMovies.length; i += batchSize) {
                const batch = allMovies.slice(i, i + batchSize);

                const batchResults = await Promise.allSettled(
                    batch.map((movie) =>
                        this.processMoviePosterWithTracking(movie)
                    )
                );

                // Collect successful uploads for invalidation
                batchResults.forEach((result, index) => {
                    if (result.status === "fulfilled" && result.value) {
                        uploadedPosters.push(result.value);
                    }
                });

                // Delay between batches
                if (i + batchSize < allMovies.length) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, this.tmdbApiDelay)
                    );
                }
            }

            // Batch invalidate all uploaded posters
            if (uploadedPosters.length > 0) {
                console.log(
                    `🔄 Invalidating CloudFront cache for ${uploadedPosters.length} posters...`
                );
                await this.invalidateCloudFrontCache(uploadedPosters);
            }

            console.log("✅ Poster processing completed");
        } catch (error) {
            console.error("❌ Poster processing failed:", error);
            throw error;
        } finally {
            this.isProcessingPosters = false;
        }
    }

    async processMoviePosterWithTracking(movie) {
        try {
            await this.processMoviePoster(movie);

            // Return the cache path for invalidation
            const ownerIdentityId = this.getIdentityId();
            return `/${CONFIG.posterUploadPath}/${ownerIdentityId}/poster_${movie.movieId}.jpg`;
        } catch (error) {
            console.warn(
                `⚠️ Failed to process poster for ${movie.name}:`,
                error.message
            );
            return null;
        }
    }

    async getExistingPosters(ownerIdentityId) {
        try {
            const listParams = {
                Bucket: CONFIG.posterBucketName,
                Prefix: `${CONFIG.posterUploadPath}/${ownerIdentityId}/`,
                MaxKeys: 5000,
            };

            const listResult = await this.s3.send(
                new ListObjectsV2Command(listParams)
            );
            const existingPosters = new Set();

            if (listResult.Contents && listResult.Contents.length > 0) {
                for (const object of listResult.Contents) {
                    // Extract movieId from filename: poster_<movieId>.jpg
                    const filename = object.Key.split("/").pop();
                    const match = filename.match(
                        /^poster_(.+)\.(jpg|jpeg|png|webp)$/i
                    );
                    if (match) {
                        existingPosters.add(match[1]);
                    }
                }
            }

            return existingPosters;
        } catch (error) {
            console.warn("Failed to check existing posters:", error.message);
            return new Set();
        }
    }

    async processMoviePoster(movie) {
        try {
            console.log(
                `🎬 Processing poster for: ${movie.name} (${movie.year})`
            );

            // Clean title for search (use the same logic as frontend)
            const cleanedTitle = this.cleanMovieTitleForSearch(movie.name);

            // Search TMDB via API Gateway
            const queryParams = new URLSearchParams();
            queryParams.append("query", cleanedTitle);
            if (movie.year) {
                queryParams.append("year", movie.year);
            }

            const response = await this.makeAuthenticatedAPIRequest(
                "GET",
                `metadata?${queryParams.toString()}`
            );

            if (!response.ok) {
                const errorText = await response.text();
                console.warn(
                    `Failed to get metadata: ${response.status} ${errorText}`
                );
            }

            const resultJson = await response.json();
            // console.log(`   TMDB API response for ${movie.name}:`, resultJson);
            if (
                !resultJson ||
                !resultJson.results ||
                resultJson.results.length === 0
            ) {
                console.log(`   No TMDB results for: ${movie.name}`);
                return;
            }

            const movieData = resultJson.results[0];
            if (!movieData.poster_path) {
                console.log(`   No poster available for: ${movie.name}`);
                return;
            }

            // Download and upload poster
            await this.downloadAndUploadPoster(
                movie.movieId,
                movieData.poster_path
            );

            console.log(`✅ Poster processed for: ${movie.name}`);
        } catch (error) {
            console.warn(
                `⚠️ Failed to process poster for ${movie.name}:`,
                error.message
            );
        }
    }

    async downloadAndUploadPoster(movieId, posterPath) {
        try {
            // Use w500 size for good quality but reasonable file size
            const posterUrl = `${CONFIG.tmdbImageBaseUrl}${posterPath}`;

            console.log(`📥 Downloading poster: ${posterUrl}`);

            // Download poster image
            const response = await fetch(posterUrl);
            if (!response.ok) {
                throw new Error(
                    `Failed to download poster: ${response.status}`
                );
            }

            const posterBuffer = await response.arrayBuffer();
            const contentType =
                response.headers.get("content-type") || "image/jpeg";

            // Determine file extension
            const extension = contentType.includes("png") ? "png" : "jpg";
            const filename = `poster_${movieId}.${extension}`;

            // Upload to S3
            const ownerIdentityId = this.getIdentityId();
            const s3Key = `${CONFIG.posterUploadPath}/${ownerIdentityId}/${filename}`;

            const uploadParams = {
                Bucket: CONFIG.posterBucketName,
                Key: s3Key,
                Body: new Uint8Array(posterBuffer),
                ContentType: contentType,
                CacheControl: "public, max-age=31536000", // Cache for 1 year
                Metadata: {
                    movieId: movieId,
                    source: "tmdb",
                    originalPath: posterPath,
                },
            };

            const upload = new Upload({
                client: this.s3,
                params: uploadParams,
            });

            await upload.done();
            console.log(`📦 Poster uploaded: ${filename}`);
        } catch (error) {
            console.error(
                `❌ Failed to download/upload poster for ${movieId}:`,
                error
            );
            throw error;
        }
    }

    cleanMovieTitleForSearch(title) {
        if (!title) return title;

        let cleanedTitle = title;

        // Replace em dashes (–) with regular hyphens (-)
        cleanedTitle = cleanedTitle.replace(/–/g, "-");

        // Remove problematic strings that interfere with search
        const problematicStrings = [
            /\s*[-–]\s*Theatrical\s+Cut\s*/gi,
            /\s*[-–]\s*Theater\s+Cut\s*/gi,
            /\s*[-–]\s*Extended\s+Cut\s*/gi,
            /\s*[-–]\s*Ultimate\s+Cut\s*/gi,
            /\s*[-–]\s*Final\s+Cut\s*/gi,
            /\s*[-–]\s*Unrated\s+Cut\s*/gi,
            /\s*[-–]\s*Uncut\s*/gi,
            /\s*[-–]\s*Remastered\s*/gi,
            /\s*[-–]\s*Special\s+Edition\s*/gi,
            /\s*[-–]\s*Anniversary\s+Edition\s*/gi,
            /\s*[-–]\s*Collector's\s+Edition\s*/gi,
            /\s*[-–]\s*Limited\s+Edition\s*/gi,
            /\s*[-–]\s*Criterion\s+Collection\s*/gi,
            /\s*\(.*?Cut\)\s*/gi,
            /\s*\(.*?Edition\)\s*/gi,
            /\s*\(Remastered\)\s*/gi,
            /\s*\(Unrated\)\s*/gi,
            /\s*\(Uncut\)\s*/gi,
        ];

        problematicStrings.forEach((pattern) => {
            cleanedTitle = cleanedTitle.replace(pattern, "");
        });

        cleanedTitle = cleanedTitle.replace(/\s+/g, " ").trim();
        cleanedTitle = cleanedTitle.replace(/[,;:.!?]+$/, "");

        return cleanedTitle;
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
                if (!args[2]) {
                    console.error("Please provide movie id");
                    process.exit(1);
                }
                await worker.uploadMedia(args[1], args[2]);
                break;

            // case "list-media":
            //     const mediaFiles = await worker.listFiles(
            //         CONFIG.mediaBucketName
            //     );
            //     console.log("Media files:");
            //     mediaFiles.forEach((file) => console.log(`  ${file.Key}`));
            //     break;

            // case "list-playlists":
            //     const playlistFiles = await worker.listFiles(
            //         CONFIG.playlistBucketName
            //     );
            //     console.log("Playlist files:");
            //     playlistFiles.forEach((file) => console.log(`  ${file.Key}`));
            //     break;

            // case "check-ffmpeg":
            //     await worker.checkFFmpeg();
            //     break;

            case "status":
                await worker.showStatus();
                break;

            case "login":
                // Already logged in
                // await worker.login();
                break;

            case "upload-status":
                const uploadStatus = worker.getUploadStatus();
                console.log("📊 Current Upload Status:");
                console.log(JSON.stringify(uploadStatus, null, 2));
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

            case "worker":
                console.log("Starting worker mode (Ctrl+C to stop)");

                // Handle graceful shutdown
                process.on("SIGINT", () => {
                    console.log(
                        "\nReceived SIGINT, shutting down gracefully..."
                    );
                    worker.stopWorkerMode();
                    process.exit(0);
                });

                await worker.startWorkerMode();
                break;

            default:
                console.log("Available commands:");
                console.log(
                    "  upload-media <file-path>    - Upload a media file (video files use HLS)"
                );
                // console.log(
                //     "  list-media                  - List uploaded media files"
                // );
                // console.log(
                //     "  list-playlists              - List uploaded playlist files"
                // );
                // console.log(
                //     "  check-ffmpeg                - Check if FFmpeg is available"
                // );
                console.log(
                    "  scan-library <path> [--save <output-file>] - Scan movie library and extract metadata"
                );
                console.log(
                    "  worker                      - Start worker mode (polls SQS for commands)"
                );
                console.log(
                    "  status                      - Show authentication status"
                );
                console.log("  login                      - Log in");
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
