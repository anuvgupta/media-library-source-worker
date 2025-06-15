const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
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

class MP4HLSUploader {
    constructor(options = {}) {
        this.bucketName = options.bucketName || "example-bucket";
        this.segmentDuration = options.segmentDuration || 10; // 10 second segments
        this.concurrentUploads = options.concurrentUploads || 3;
        this.prioritySegments = options.prioritySegments || 5; // Upload first N segments immediately
        this.tempDir = options.tempDir || "./temp";

        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async uploadMovie(filePath, movieId) {
        try {
            console.log(
                `Starting HLS conversion and upload for movie: ${movieId}`
            );
            console.log(`File: ${filePath}`);

            const fileStats = fs.statSync(filePath);
            const totalSize = fileStats.size;
            console.log(
                `Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`
            );

            // Create upload session
            const uploadSession = {
                movieId,
                totalSegments: 0,
                uploadedSegments: 0,
                totalSize,
                startTime: Date.now(),
                status: "converting",
            };

            // Step 1: Convert to HLS segments
            const segmentInfo = await this.convertToHLS(filePath, movieId);
            uploadSession.totalSegments = segmentInfo.totalSegments;

            console.log(`Total segments: ${segmentInfo.totalSegments}`);
            console.log(`Segment duration: ${this.segmentDuration}s`);

            // Step 2: Upload priority segments first
            await this.uploadPrioritySegments(
                movieId,
                uploadSession,
                segmentInfo
            );

            // Step 3: Upload remaining segments
            await this.uploadRemainingSegments(
                movieId,
                uploadSession,
                segmentInfo
            );

            // Step 4: Upload master playlist
            await this.uploadMasterPlaylist(movieId, segmentInfo);

            // Cleanup temp files
            await this.cleanup(movieId);

            console.log(`✅ Upload completed for movie: ${movieId}`);
            return uploadSession;
        } catch (error) {
            console.error(`❌ Upload failed for movie: ${movieId}`, error);
            await this.cleanup(movieId);
            throw error;
        }
    }

    async convertToHLS(filePath, movieId) {
        console.log(`🔄 Converting to HLS segments...`);

        const outputDir = path.join(this.tempDir, movieId);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const playlistPath = path.join(outputDir, "playlist.m3u8");
        const segmentPattern = path.join(outputDir, "segment_%06d.ts");

        return new Promise((resolve, reject) => {
            const ffmpegArgs = [
                "-i",
                filePath,
                "-c:v",
                "libx264", // Video codec
                "-c:a",
                "aac", // Audio codec
                "-preset",
                "fast", // Encoding speed
                "-crf",
                "23", // Quality (lower = better)
                "-sc_threshold",
                "0", // Disable scene change detection
                "-g",
                "48", // GOP size (keyframe interval)
                "-keyint_min",
                "48", // Minimum keyframe interval
                "-hls_time",
                this.segmentDuration.toString(), // Segment duration
                "-hls_playlist_type",
                "vod", // Video on demand
                "-hls_segment_filename",
                segmentPattern,
                "-f",
                "hls",
                playlistPath,
            ];

            console.log(`Running FFmpeg: ffmpeg ${ffmpegArgs.join(" ")}`);

            const ffmpeg = spawn("ffmpeg", ffmpegArgs);
            let stderr = "";

            ffmpeg.stderr.on("data", (data) => {
                stderr += data.toString();
                // Parse progress from FFmpeg output
                const progressMatch = stderr.match(
                    /time=(\d{2}):(\d{2}):(\d{2})/
                );
                if (progressMatch) {
                    const hours = parseInt(progressMatch[1]);
                    const minutes = parseInt(progressMatch[2]);
                    const seconds = parseInt(progressMatch[3]);
                    const currentTime = hours * 3600 + minutes * 60 + seconds;
                    process.stdout.write(
                        `\r🔄 Converting... ${Math.floor(currentTime / 60)}:${(
                            currentTime % 60
                        )
                            .toString()
                            .padStart(2, "0")}`
                    );
                }
            });

            ffmpeg.on("close", (code) => {
                console.log(""); // New line after progress

                if (code !== 0) {
                    console.error("FFmpeg stderr:", stderr);
                    reject(new Error(`FFmpeg failed with code ${code}`));
                    return;
                }

                try {
                    // Count generated segments
                    const files = fs.readdirSync(outputDir);
                    const segmentFiles = files.filter(
                        (f) => f.startsWith("segment_") && f.endsWith(".ts")
                    );
                    const totalSegments = segmentFiles.length;

                    console.log(
                        `✅ Conversion completed. Generated ${totalSegments} segments`
                    );

                    resolve({
                        totalSegments,
                        outputDir,
                        playlistPath,
                        segmentFiles: segmentFiles.sort(),
                    });
                } catch (error) {
                    reject(error);
                }
            });

            ffmpeg.on("error", (error) => {
                reject(new Error(`FFmpeg spawn error: ${error.message}`));
            });
        });
    }

    async uploadPrioritySegments(movieId, uploadSession, segmentInfo) {
        console.log(
            `🚀 Uploading priority segments (first ${this.prioritySegments})...`
        );

        const priorityFiles = segmentInfo.segmentFiles.slice(
            0,
            Math.min(this.prioritySegments, segmentInfo.totalSegments)
        );

        const priorityPromises = priorityFiles.map((filename, index) =>
            this.uploadSegment(
                movieId,
                filename,
                index,
                uploadSession,
                segmentInfo.outputDir
            )
        );

        await Promise.all(priorityPromises);

        // Upload initial playlist for priority segments
        await this.uploadPartialPlaylist(
            movieId,
            priorityFiles.length,
            segmentInfo
        );

        console.log(`✅ Priority segments uploaded. Ready for playback!`);

        uploadSession.status = "ready_for_playback";
        await this.updateUploadStatus(movieId, uploadSession);
    }

    async uploadRemainingSegments(movieId, uploadSession, segmentInfo) {
        console.log(`📤 Uploading remaining segments...`);

        const remainingFiles = segmentInfo.segmentFiles.slice(
            this.prioritySegments
        );

        // Upload remaining segments with concurrency control
        await this.uploadSegmentsWithConcurrency(
            movieId,
            remainingFiles,
            this.prioritySegments,
            uploadSession,
            segmentInfo.outputDir
        );

        uploadSession.status = "completed";
        await this.updateUploadStatus(movieId, uploadSession);
    }

    async uploadSegmentsWithConcurrency(
        movieId,
        segmentFiles,
        startIndex,
        uploadSession,
        outputDir
    ) {
        const batches = [];
        for (let i = 0; i < segmentFiles.length; i += this.concurrentUploads) {
            batches.push(segmentFiles.slice(i, i + this.concurrentUploads));
        }

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const batchPromises = batch.map((filename, batchPos) => {
                const segmentIndex =
                    startIndex + batchIndex * this.concurrentUploads + batchPos;
                return this.uploadSegment(
                    movieId,
                    filename,
                    segmentIndex,
                    uploadSession,
                    outputDir
                );
            });
            await Promise.all(batchPromises);

            // Update playlist after each batch
            const uploadedCount = Math.min(
                this.prioritySegments +
                    (batchIndex + 1) * this.concurrentUploads,
                uploadSession.totalSegments
            );
            await this.uploadPartialPlaylist(movieId, uploadedCount, {
                segmentFiles: segmentFiles,
            });
        }
    }

    async uploadSegment(
        movieId,
        filename,
        segmentIndex,
        uploadSession,
        outputDir
    ) {
        try {
            const segmentPath = path.join(outputDir, filename);
            const segmentBuffer = fs.readFileSync(segmentPath);

            const key = `${S3_UPLOAD_PATH}/${movieId}/segments/${filename}`;

            const uploadParams = {
                Bucket: this.bucketName,
                Key: key,
                Body: segmentBuffer,
                ContentType: "video/mp2t", // MPEG-2 Transport Stream
                Metadata: {
                    movieId: movieId,
                    segmentIndex: segmentIndex.toString(),
                    totalSegments: uploadSession.totalSegments.toString(),
                },
            };

            await s3.upload(uploadParams).promise();

            uploadSession.uploadedSegments++;
            const progress = (
                (uploadSession.uploadedSegments / uploadSession.totalSegments) *
                100
            ).toFixed(1);

            console.log(
                `📦 Segment ${segmentIndex + 1}/${
                    uploadSession.totalSegments
                } uploaded (${progress}%)`
            );

            // Update progress periodically
            if (uploadSession.uploadedSegments % 3 === 0) {
                await this.updateUploadStatus(movieId, uploadSession);
            }
        } catch (error) {
            console.error(`❌ Failed to upload segment ${filename}:`, error);
            throw error;
        }
    }

    async uploadPartialPlaylist(movieId, segmentCount, segmentInfo) {
        // Generate HLS playlist for available segments
        let playlist = "#EXTM3U\n";
        playlist += "#EXT-X-VERSION:3\n";
        playlist += `#EXT-X-TARGETDURATION:${this.segmentDuration}\n`;
        playlist += "#EXT-X-MEDIA-SEQUENCE:0\n";

        // Add segments that are available
        for (let i = 0; i < segmentCount; i++) {
            const filename = segmentInfo.segmentFiles[i];
            playlist += `#EXTINF:${this.segmentDuration}.0,\n`;
            playlist += `https://${WEBSITE_DOMAIN}/${S3_UPLOAD_PATH}/${movieId}/segments/${filename}\n`;
        }

        // Only add end tag if all segments are uploaded
        if (segmentCount >= segmentInfo.totalSegments) {
            playlist += "#EXT-X-ENDLIST\n";
        }

        const playlistParams = {
            Bucket: this.bucketName,
            Key: `${S3_UPLOAD_PATH}/${movieId}/playlist.m3u8`,
            Body: playlist,
            ContentType: "application/vnd.apple.mpegurl",
        };

        await s3.upload(playlistParams).promise();
        console.log(`📝 Playlist updated (${segmentCount} segments available)`);
    }

    async uploadMasterPlaylist(movieId, segmentInfo) {
        // Generate final HLS playlist
        let playlist = "#EXTM3U\n";
        playlist += "#EXT-X-VERSION:3\n";
        playlist += `#EXT-X-TARGETDURATION:${this.segmentDuration}\n`;
        playlist += "#EXT-X-MEDIA-SEQUENCE:0\n";

        for (let i = 0; i < segmentInfo.totalSegments; i++) {
            const filename = segmentInfo.segmentFiles[i];
            playlist += `#EXTINF:${this.segmentDuration}.0,\n`;
            playlist += `https://${WEBSITE_DOMAIN}/cache/movies/${movieId}/segments/${filename}\n`;
        }

        playlist += "#EXT-X-ENDLIST\n";

        const playlistParams = {
            Bucket: this.bucketName,
            Key: `cache/movies/${movieId}/playlist.m3u8`,
            Body: playlist,
            ContentType: "application/vnd.apple.mpegurl",
        };

        await s3.upload(playlistParams).promise();
        console.log(`📝 Final playlist uploaded for movie: ${movieId}`);
    }

    async updateUploadStatus(movieId, uploadSession) {
        const progress = (
            (uploadSession.uploadedSegments / uploadSession.totalSegments) *
            100
        ).toFixed(1);
        const elapsed = ((Date.now() - uploadSession.startTime) / 1000).toFixed(
            1
        );

        console.log(
            `📊 Status Update - Movie: ${movieId}, Progress: ${progress}%, Elapsed: ${elapsed}s, Status: ${uploadSession.status}`
        );
    }

    async cleanup(movieId) {
        try {
            const outputDir = path.join(this.tempDir, movieId);
            if (fs.existsSync(outputDir)) {
                const files = fs.readdirSync(outputDir);
                for (const file of files) {
                    fs.unlinkSync(path.join(outputDir, file));
                }
                fs.rmdirSync(outputDir);
                console.log(`🧹 Cleaned up temp files for: ${movieId}`);
            }
        } catch (error) {
            console.warn(`⚠️ Cleanup failed for ${movieId}:`, error.message);
        }
    }
}

// Worker implementation
class MovieUploadWorker {
    constructor() {
        this.uploader = new MP4HLSUploader({
            bucketName: S3_BUCKET_NAME,
            segmentDuration: 10, // 10 second segments
            concurrentUploads: 3,
            prioritySegments: 5,
            tempDir: "./temp",
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

            // Check if FFmpeg is available
            await this.checkFFmpeg();

            // Start upload
            const uploadSession = await this.uploader.uploadMovie(
                moviePath,
                movieId
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

    async checkFFmpeg() {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn("ffmpeg", ["-version"]);

            ffmpeg.on("close", (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(
                        new Error(
                            "FFmpeg not found. Please install FFmpeg to use this uploader."
                        )
                    );
                }
            });

            ffmpeg.on("error", () => {
                reject(
                    new Error(
                        "FFmpeg not found. Please install FFmpeg to use this uploader."
                    )
                );
            });
        });
    }

    start() {
        console.log("🚀 Movie HLS upload worker started");
        console.log("Waiting for upload requests...");

        this.processTestUpload();
    }

    processTestUpload() {
        const testMoviePath = "./tst/test-movie.mp4";
        const testMovieId = "test";

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

module.exports = { MP4HLSUploader, MovieUploadWorker };
