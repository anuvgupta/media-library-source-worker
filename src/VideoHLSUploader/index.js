// VideoHLSUploader/index.js

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { promisify } = require("util");
const { Upload } = require("@aws-sdk/lib-storage");
const { ListObjectsV2Command } = require("@aws-sdk/client-s3");

class VideoHLSUploader {
    constructor(options = {}) {
        // Required parameters
        if (!options.s3Client) {
            throw new Error("s3Client is required");
        }
        if (!options.mediaBucketName) {
            throw new Error("mediaBucketName is required");
        }
        if (!options.playlistBucketName) {
            throw new Error("playlistBucketName is required");
        }
        if (!options.mediaUploadPath) {
            throw new Error("mediaUploadPath is required");
        }
        if (!options.playlistUploadPath) {
            throw new Error("playlistUploadPath is required");
        }
        if (!options.websiteDomain) {
            throw new Error("websiteDomain is required");
        }

        this.s3Client = options.s3Client;
        this.mediaBucketName = options.mediaBucketName;
        this.playlistBucketName = options.playlistBucketName;
        this.mediaUploadPath = options.mediaUploadPath;
        this.playlistUploadPath = options.playlistUploadPath;
        this.websiteDomain = options.websiteDomain;
        this.makeAuthenticatedAPIRequest = options.makeAuthenticatedAPIRequest;

        // Optional parameters
        this.segmentDuration = options.segmentDuration || 10; // 10 second segments
        this.concurrentUploads = options.concurrentUploads || 3;
        this.prioritySegments = options.prioritySegments || 5; // Upload first N segments immediately
        this.tempDir = options.tempDir || "./temp";
        this.supportedFormats = [".mp4", ".mkv", ".avi", ".mov", ".m4v"];
        this.skipExistingSegments = options.skipExistingSegments !== false; // Default to true
        this.existingSegments = new Set(); // Track which segments already exist
        // this.testFiles = options.testFiles || [
        //     "./tst/test-movie.mp4",
        //     "./tst/test-movie.mkv",
        //     "./tst/test.mp4",
        //     "./tst/test.mkv",
        // ];

        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async uploadMovie(filePath, movieId, uploadSubpath) {
        try {
            this.uploadSubpath = uploadSubpath;
            console.log(
                `Starting HLS conversion and upload for movie: ${movieId}`
            );
            console.log(`File: ${filePath}`);

            // Validate file format
            if (!this.isValidVideoFile(filePath)) {
                throw new Error(
                    `Unsupported video format. Supported: ${this.supportedFormats.join(
                        ", "
                    )}`
                );
            }

            const fileStats = fs.statSync(filePath);
            const totalSize = fileStats.size;
            console.log(
                `Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`
            );

            // Check for existing segments BEFORE conversion
            this.existingSegments = await this.checkExistingSegments(
                movieId,
                uploadSubpath
            );

            // Analyze video file
            const videoInfo = await this.analyzeVideoFile(filePath);
            console.log(
                `Video info: ${videoInfo.resolution}, ${videoInfo.videoCodec}, ${videoInfo.audioCodec}, ${videoInfo.duration}s`
            );

            // Create upload session
            const uploadSession = {
                movieId,
                totalSegments: 0,
                uploadedSegments: this.existingSegments.size, // Start with existing segments
                skippedSegments: this.existingSegments.size,
                totalSize,
                startTime: Date.now(),
                status: "converting",
                videoInfo,
            };

            // Step 1: Convert to HLS segments
            const segmentInfo = await this.convertToHLS(
                filePath,
                movieId,
                videoInfo
            );
            uploadSession.totalSegments = segmentInfo.totalSegments;

            // Log resume information
            if (this.existingSegments.size > 0) {
                console.log(
                    `🔄 Resuming upload: ${this.existingSegments.size}/${segmentInfo.totalSegments} segments already exist`
                );
            }

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

    isValidVideoFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        return this.supportedFormats.includes(ext);
    }

    async analyzeVideoFile(filePath) {
        console.log(`🔍 Analyzing video file...`);

        return new Promise((resolve, reject) => {
            const ffprobeArgs = [
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                filePath,
            ];

            const ffprobe = spawn("ffprobe", ffprobeArgs);
            let stdout = "";
            let stderr = "";

            ffprobe.stdout.on("data", (data) => {
                stdout += data.toString();
            });

            ffprobe.stderr.on("data", (data) => {
                stderr += data.toString();
            });

            ffprobe.on("close", (code) => {
                if (code !== 0) {
                    reject(new Error(`FFprobe failed: ${stderr}`));
                    return;
                }

                try {
                    const info = JSON.parse(stdout);
                    const videoStream = info.streams.find(
                        (s) => s.codec_type === "video"
                    );
                    const audioStream = info.streams.find(
                        (s) => s.codec_type === "audio"
                    );

                    const videoInfo = {
                        duration: parseFloat(info.format.duration),
                        videoCodec: videoStream
                            ? videoStream.codec_name
                            : "unknown",
                        audioCodec: audioStream
                            ? audioStream.codec_name
                            : "unknown",
                        resolution: videoStream
                            ? `${videoStream.width}x${videoStream.height}`
                            : "unknown",
                        bitrate: parseInt(info.format.bit_rate) || 0,
                        needsReencoding: this.needsReencoding(
                            videoStream,
                            audioStream
                        ),
                    };

                    resolve(videoInfo);
                } catch (error) {
                    reject(
                        new Error(
                            `Failed to parse video info: ${error.message}`
                        )
                    );
                }
            });

            ffprobe.on("error", (error) => {
                reject(new Error(`FFprobe spawn error: ${error.message}`));
            });
        });
    }

    needsReencoding(videoStream, audioStream) {
        // Check if video needs re-encoding
        const videoCodec = videoStream
            ? videoStream.codec_name.toLowerCase()
            : "";
        const audioCodec = audioStream
            ? audioStream.codec_name.toLowerCase()
            : "";

        // Keep modern codecs: H.264, H.265/HEVC, VP9, AV1
        const compatibleVideoCodecs = [
            "h264",
            "avc",
            "hevc",
            "h265",
            "vp9",
            "av01",
        ];
        const videoNeedsReencoding =
            !compatibleVideoCodecs.includes(videoCodec);

        // Keep web-compatible audio codecs
        const compatibleAudioCodecs = ["aac", "mp3", "opus"];
        const audioNeedsReencoding =
            !compatibleAudioCodecs.includes(audioCodec);

        return {
            video: videoNeedsReencoding,
            audio: audioNeedsReencoding,
            reason: {
                video: videoNeedsReencoding
                    ? `${videoCodec} not web-compatible`
                    : "keeping original",
                audio: audioNeedsReencoding
                    ? `${audioCodec} -> aac`
                    : "keeping original",
            },
        };
    }

    async convertToHLS(filePath, movieId, videoInfo) {
        console.log(`🔄 Converting to HLS segments...`);

        const outputDir = path.join(this.tempDir, movieId);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const playlistPath = path.join(outputDir, "playlist.m3u8");
        const segmentPattern = path.join(outputDir, "segment_%06d.ts");

        return new Promise((resolve, reject) => {
            // Build FFmpeg arguments based on video analysis
            const ffmpegArgs = ["-i", filePath];

            // Video encoding settings
            if (videoInfo.needsReencoding.video) {
                console.log(
                    `🔄 Re-encoding video: ${videoInfo.needsReencoding.reason.video}`
                );
                ffmpegArgs.push(
                    "-c:v",
                    "libx264", // Fallback to H.264 for unsupported codecs
                    "-preset",
                    "fast", // Encoding speed
                    "-crf",
                    "23", // Quality (lower = better)
                    "-profile:v",
                    "high", // H.264 profile
                    "-level:v",
                    "4.0" // H.264 level
                );
            } else {
                console.log(
                    `✅ Video codec compatible (${videoInfo.videoCodec}), copying stream`
                );
                ffmpegArgs.push("-c:v", "copy"); // Copy video stream without re-encoding
            }

            // Audio encoding settings
            if (videoInfo.needsReencoding.audio) {
                console.log(
                    `🔄 Re-encoding audio: ${videoInfo.needsReencoding.reason.audio}`
                );
                ffmpegArgs.push(
                    "-c:a",
                    "aac", // Re-encode to AAC
                    "-b:a",
                    "128k" // Audio bitrate
                );
            } else {
                console.log(
                    `✅ Audio codec compatible (${videoInfo.audioCodec}), copying stream`
                );
                ffmpegArgs.push("-c:a", "copy"); // Copy audio stream without re-encoding
            }

            // HLS segmentation settings
            ffmpegArgs.push(
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
                playlistPath
            );

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
                    const totalTime = videoInfo.duration;
                    const progress =
                        totalTime > 0
                            ? ((currentTime / totalTime) * 100).toFixed(1)
                            : 0;
                    process.stdout.write(
                        `\r🔄 Converting... ${Math.floor(currentTime / 60)}:${(
                            currentTime % 60
                        )
                            .toString()
                            .padStart(2, "0")} (${progress}%)`
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
            segmentInfo.outputDir,
            segmentInfo
        );

        uploadSession.status = "completed";
        await this.updateUploadStatus(movieId, uploadSession);
    }

    async uploadSegmentsWithConcurrency(
        movieId,
        segmentFiles,
        startIndex,
        uploadSession,
        outputDir,
        segmentInfo
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
            await this.uploadPartialPlaylist(
                movieId,
                uploadedCount,
                segmentInfo
            );
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
            // Check if segment already exists
            if (this.existingSegments.has(filename)) {
                console.log(
                    `⏭️  Skipping existing segment ${segmentIndex + 1}/${
                        uploadSession.totalSegments
                    }: ${filename}`
                );

                // Don't increment uploadedSegments since we're not actually uploading
                const progress = (
                    (uploadSession.uploadedSegments /
                        uploadSession.totalSegments) *
                    100
                ).toFixed(1);
                console.log(
                    `📊 Progress: ${progress}% (${uploadSession.uploadedSegments}/${uploadSession.totalSegments}, ${uploadSession.skippedSegments} skipped)`
                );

                return; // Skip upload
            }

            const segmentPath = path.join(outputDir, filename);
            const segmentBuffer = fs.readFileSync(segmentPath);

            const key = `${this.mediaUploadPath}/${this.uploadSubpath}/movie/${movieId}/segments/${filename}`;

            const uploadParams = {
                Bucket: this.mediaBucketName,
                Key: key,
                Body: segmentBuffer,
                ContentType: "video/mp2t", // MPEG-2 Transport Stream
                CacheControl: "public, max-age=31536000", // Cache segments for 1 year (they never change)
                Metadata: {
                    movieId: movieId,
                    segmentIndex: segmentIndex.toString(),
                    totalSegments: uploadSession.totalSegments.toString(),
                },
            };

            const upload = new Upload({
                client: this.s3Client,
                params: uploadParams,
            });

            await upload.done();

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

    // Replace uploadPartialPlaylist method
    async uploadPartialPlaylist(
        movieId,
        segmentCount,
        segmentInfo,
        presignedUrls
    ) {
        // Create simple template playlist (no pre-signed URLs)
        let templatePlaylist = "#EXTM3U\n";
        templatePlaylist += "#EXT-X-VERSION:3\n";
        templatePlaylist += `#EXT-X-TARGETDURATION:${this.segmentDuration}\n`;
        templatePlaylist += "#EXT-X-MEDIA-SEQUENCE:0\n";

        // Add all segments with just filenames
        for (let i = 0; i < segmentInfo.totalSegments; i++) {
            const filename = segmentInfo.segmentFiles[i];
            templatePlaylist += `#EXTINF:${this.segmentDuration}.0,\n`;
            templatePlaylist += `${filename}\n`;
        }

        // Don't add end tag to template
        // DONT: templatePlaylist += "#EXT-X-ENDLIST\n";

        // Upload template playlist (only once, when first called)
        if (
            segmentCount ===
            Math.min(this.prioritySegments, segmentInfo.totalSegments)
        ) {
            const templateParams = {
                Bucket: this.playlistBucketName,
                Key: `${this.playlistUploadPath}/${this.uploadSubpath}/movie/${movieId}/playlist-template.m3u8`,
                Body: templatePlaylist,
                ContentType: "application/vnd.apple.mpegurl",
            };

            const upload = new Upload({
                client: this.s3Client,
                params: templateParams,
            });

            await upload.done();
            console.log(`📝 Template playlist uploaded`);
        }

        // Call API to process template into real playlist
        await this.processPlaylistViaAPI(
            movieId,
            segmentCount,
            segmentInfo.totalSegments
        );
    }

    async processPlaylistViaAPI(movieId, segmentCount, totalSegments) {
        try {
            console.log(
                `🔄 Processing playlist via API (${segmentCount}/${totalSegments} segments)`
            );

            const isComplete = segmentCount >= totalSegments;
            const apiEndpoint = `libraries/${this.uploadSubpath}/movies/${movieId}/playlist/process`;

            const requestBody = {
                segmentCount,
                totalSegments,
                isComplete,
            };

            const response = await this.makeAuthenticatedAPIRequest(
                "POST",
                apiEndpoint,
                requestBody
            );

            if (response.ok) {
                const result = await response.json();
                console.log(`✅ Playlist processed successfully via API`);
                return result;
            } else {
                const errorText = await response.text();
                throw new Error(
                    `API request failed: ${response.status} ${errorText}`
                );
            }
        } catch (error) {
            console.error("❌ Failed to process playlist via API:", error);
            throw error;
        }
    }

    async updateUploadStatus(movieId, uploadSession) {
        const actualUploaded =
            uploadSession.uploadedSegments - uploadSession.skippedSegments;
        const progress = (
            (uploadSession.uploadedSegments / uploadSession.totalSegments) *
            100
        ).toFixed(1);
        const elapsed = ((Date.now() - uploadSession.startTime) / 1000).toFixed(
            1
        );

        console.log(
            `📊 Status Update - Movie: ${movieId}, Progress: ${progress}%, Uploaded: ${actualUploaded}, Skipped: ${uploadSession.skippedSegments}, Elapsed: ${elapsed}s, Status: ${uploadSession.status}`
        );
    }

    // Add method to check existing segments
    async checkExistingSegments(movieId, uploadSubpath) {
        if (!this.skipExistingSegments) {
            console.log(
                "⏭️  Segment skipping disabled, will upload all segments"
            );
            return new Set();
        }

        try {
            console.log("🔍 Checking for existing segments...");

            const listParams = {
                Bucket: this.mediaBucketName,
                Prefix: `${this.mediaUploadPath}/${uploadSubpath}/movie/${movieId}/segments/`,
                MaxKeys: 3000, // Should be enough for most movies
            };

            const listResult = await this.s3Client.send(
                new ListObjectsV2Command(listParams)
            );

            const existingSegments = new Set();

            if (listResult.Contents && listResult.Contents.length > 0) {
                for (const object of listResult.Contents) {
                    // Extract filename from the key
                    const filename = object.Key.split("/").pop();
                    if (
                        filename &&
                        filename.startsWith("segment_") &&
                        filename.endsWith(".ts")
                    ) {
                        existingSegments.add(filename);
                    }
                }

                console.log(
                    `📋 Found ${existingSegments.size} existing segments to skip`
                );
                if (existingSegments.size > 0) {
                    const sortedSegments = Array.from(existingSegments).sort();
                    console.log(
                        `   First: ${sortedSegments[0]}, Last: ${
                            sortedSegments[sortedSegments.length - 1]
                        }`
                    );
                }
            } else {
                console.log(
                    "📋 No existing segments found, starting fresh upload"
                );
            }

            return existingSegments;
        } catch (error) {
            console.warn(
                "⚠️  Failed to check existing segments, will upload all:",
                error.message
            );
            return new Set();
        }
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

module.exports = { VideoHLSUploader };
