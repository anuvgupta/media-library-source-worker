const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const S3_UPLOAD_PATH = process.env.S3_UPLOAD_PATH;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const AWS_REGION = process.env.AWS_REGION;
const WEBSITE_DOMAIN = process.env.WEBSITE_DOMAIN;

// Configure AWS
const s3 = new AWS.S3({
    region: AWS_REGION,
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
});

class MP4ChunkedUploader {
    constructor(options = {}) {
        this.bucketName = options.bucketName || "example-bucket";
        this.chunkSizeBytes = options.chunkSizeBytes || 10 * 1024 * 1024; // 10MB chunks
        this.concurrentUploads = options.concurrentUploads || 3;
        this.priorityChunks = options.priorityChunks || 5; // Upload first N chunks immediately
    }

    async uploadMovie(filePath, movieId) {
        try {
            console.log(`Starting upload for movie: ${movieId}`);
            console.log(`File: ${filePath}`);

            const fileStats = fs.statSync(filePath);
            const totalSize = fileStats.size;
            const totalChunks = Math.ceil(totalSize / this.chunkSizeBytes);

            console.log(
                `Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`
            );
            console.log(`Total chunks: ${totalChunks}`);
            console.log(
                `Chunk size: ${(this.chunkSizeBytes / 1024 / 1024).toFixed(
                    2
                )} MB`
            );

            // Create upload session
            const uploadSession = {
                movieId,
                totalChunks,
                uploadedChunks: 0,
                totalSize,
                startTime: Date.now(),
                status: "uploading",
            };

            // Upload priority chunks first (for immediate playback)
            await this.uploadPriorityChunks(filePath, movieId, uploadSession);

            // Continue uploading remaining chunks
            await this.uploadRemainingChunks(filePath, movieId, uploadSession);

            console.log(`✅ Upload completed for movie: ${movieId}`);
            return uploadSession;
        } catch (error) {
            console.error(`❌ Upload failed for movie: ${movieId}`, error);
            throw error;
        }
    }

    async uploadPriorityChunks(filePath, movieId, uploadSession) {
        console.log(
            `🚀 Uploading priority chunks (first ${this.priorityChunks})...`
        );

        const priorityPromises = [];
        for (
            let i = 0;
            i < Math.min(this.priorityChunks, uploadSession.totalChunks);
            i++
        ) {
            priorityPromises.push(
                this.uploadChunk(filePath, movieId, i, uploadSession)
            );
        }

        await Promise.all(priorityPromises);
        console.log(`✅ Priority chunks uploaded. Ready for playback!`);

        // Update status to indicate ready for streaming
        uploadSession.status = "ready_for_playback";
        await this.updateUploadStatus(movieId, uploadSession);
    }

    async uploadRemainingChunks(filePath, movieId, uploadSession) {
        console.log(`📤 Uploading remaining chunks...`);

        const remainingChunks = [];
        for (let i = this.priorityChunks; i < uploadSession.totalChunks; i++) {
            remainingChunks.push(i);
        }

        // Upload remaining chunks with concurrency control
        await this.uploadChunksWithConcurrency(
            filePath,
            movieId,
            remainingChunks,
            uploadSession
        );

        uploadSession.status = "completed";
        await this.updateUploadStatus(movieId, uploadSession);
    }

    async uploadChunksWithConcurrency(
        filePath,
        movieId,
        chunkIndices,
        uploadSession
    ) {
        const batches = [];
        for (let i = 0; i < chunkIndices.length; i += this.concurrentUploads) {
            batches.push(chunkIndices.slice(i, i + this.concurrentUploads));
        }

        for (const batch of batches) {
            const batchPromises = batch.map((chunkIndex) =>
                this.uploadChunk(filePath, movieId, chunkIndex, uploadSession)
            );
            await Promise.all(batchPromises);
        }
    }

    async uploadChunk(filePath, movieId, chunkIndex, uploadSession) {
        const startByte = chunkIndex * this.chunkSizeBytes;
        const endByte = Math.min(
            startByte + this.chunkSizeBytes - 1,
            uploadSession.totalSize - 1
        );
        const chunkSize = endByte - startByte + 1;

        try {
            // Read chunk from file
            const buffer = Buffer.alloc(chunkSize);
            const fileHandle = fs.openSync(filePath, "r");
            fs.readSync(fileHandle, buffer, 0, chunkSize, startByte);
            fs.closeSync(fileHandle);

            // Upload to S3
            const chunkFileId = chunkIndex.toString().padStart(6, "0");
            const key = `cache/movies/${movieId}/chunks/chunk_${chunkFileId}.mp4`;

            const uploadParams = {
                Bucket: this.bucketName,
                Key: key,
                Body: buffer,
                ContentType: "video/mp4",
                Metadata: {
                    movieId: movieId,
                    chunkIndex: chunkIndex.toString(),
                    totalChunks: uploadSession.totalChunks.toString(),
                    startByte: startByte.toString(),
                    endByte: endByte.toString(),
                },
            };

            await s3.upload(uploadParams).promise();

            uploadSession.uploadedChunks++;
            const progress = (
                (uploadSession.uploadedChunks / uploadSession.totalChunks) *
                100
            ).toFixed(1);

            console.log(
                `📦 Chunk ${chunkIndex + 1}/${
                    uploadSession.totalChunks
                } uploaded (${progress}%)`
            );

            // Update progress periodically
            if (uploadSession.uploadedChunks % 5 === 0) {
                await this.updateUploadStatus(movieId, uploadSession);
            }
        } catch (error) {
            console.error(`❌ Failed to upload chunk ${chunkIndex}:`, error);
            throw error;
        }
    }

    async updateUploadStatus(movieId, uploadSession) {
        // This could update DynamoDB, send to SQS, or call an API
        // For now, just log the status
        const progress = (
            (uploadSession.uploadedChunks / uploadSession.totalChunks) *
            100
        ).toFixed(1);
        const elapsed = ((Date.now() - uploadSession.startTime) / 1000).toFixed(
            1
        );

        console.log(
            `📊 Status Update - Movie: ${movieId}, Progress: ${progress}%, Elapsed: ${elapsed}s, Status: ${uploadSession.status}`
        );

        // Example: Send status to API endpoint
        // await this.sendStatusUpdate(movieId, uploadSession);
    }

    async sendStatusUpdate(movieId, uploadSession) {
        // Example API call to update backend
        try {
            const response = await fetch("https://your-api.com/upload-status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    movieId,
                    progress:
                        (uploadSession.uploadedChunks /
                            uploadSession.totalChunks) *
                        100,
                    status: uploadSession.status,
                    uploadedChunks: uploadSession.uploadedChunks,
                    totalChunks: uploadSession.totalChunks,
                }),
            });
        } catch (error) {
            console.warn("Failed to send status update:", error);
        }
    }

    async generatePlaylist(movieId, totalChunks) {
        // Generate HLS playlist for the uploaded chunks
        let playlist = "#EXTM3U\n";
        playlist += "#EXT-X-VERSION:3\n";
        playlist += "#EXT-X-TARGETDURATION:10\n";
        playlist += "#EXT-X-MEDIA-SEQUENCE:0\n";

        for (let i = 0; i < totalChunks; i++) {
            playlist += "#EXTINF:10.0,\n";
            playlist += `https://${WEBSITE_DOMAIN}/cache/movies/${movieId}/chunks/chunk_${i
                .toString()
                .padStart(6, "0")}.mp4\n`;
        }

        playlist += "#EXT-X-ENDLIST\n";

        // Upload playlist to S3
        const playlistParams = {
            Bucket: this.bucketName,
            Key: `cache/movies/${movieId}/playlist.m3u8`,
            Body: playlist,
            ContentType: "application/vnd.apple.mpegurl",
        };

        await s3.upload(playlistParams).promise();
        console.log(`📝 Playlist generated for movie: ${movieId}`);
    }
}

// Worker implementation
class MovieUploadWorker {
    constructor() {
        this.uploader = new MP4ChunkedUploader({
            bucketName: S3_BUCKET_NAME,
            chunkSizeBytes: 10 * 1024 * 1024, // 10MB chunks
            concurrentUploads: 3,
            priorityChunks: 5,
        });

        this.isProcessing = false;
        this.queue = [];
    }

    async processUploadRequest(moviePath, movieId) {
        if (this.isProcessing) {
            console.log(`🔄 Adding to queue: ${movieId}`);
            this.queue.push({ moviePath, movieId });
            return;
        }

        this.isProcessing = true;

        try {
            console.log(`🎬 Processing upload request for: ${movieId}`);

            // Validate file exists
            if (!fs.existsSync(moviePath)) {
                throw new Error(`File not found: ${moviePath}`);
            }

            // Start upload
            const uploadSession = await this.uploader.uploadMovie(
                moviePath,
                movieId
            );

            // Generate playlist after upload
            await this.uploader.generatePlaylist(
                movieId,
                uploadSession.totalChunks
            );

            console.log(`✅ Movie upload completed: ${movieId}`);
        } catch (error) {
            console.error(`❌ Upload failed: ${error.message}`);
        } finally {
            this.isProcessing = false;

            // Process next in queue
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                setImmediate(() =>
                    this.processUploadRequest(next.moviePath, next.movieId)
                );
            }
        }
    }

    start() {
        console.log("🚀 Movie upload worker started");
        console.log("Waiting for upload requests...");

        // Example: Listen for requests (you'd replace this with SQS, WebSocket, etc.)
        // For demo, we'll just process a test file
        this.processTestUpload();
    }

    processTestUpload() {
        // Example usage - replace with your actual movie file
        const testMoviePath = "./tst/test-movie.mp4";
        const testMovieId = "test"; // + "_" + Date.now();

        setTimeout(() => {
            if (fs.existsSync(testMoviePath)) {
                this.processUploadRequest(testMoviePath, testMovieId);
            } else {
                console.log(
                    "No test movie found. Create test-movie.mp4 to test the uploader."
                );
            }
        }, 2000);
    }
}

// Start the worker
if (require.main === module) {
    const worker = new MovieUploadWorker();
    worker.start();
}

module.exports = { MP4ChunkedUploader, MovieUploadWorker };
