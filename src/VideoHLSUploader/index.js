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
        this.playlistFilesExist = false;
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

            const outputDir = path.join(this.tempDir, movieId);
            const playlistPath = path.join(outputDir, "playlist.m3u8");
            const segmentInfoPath = path.join(outputDir, "segment-info.json");

            let segmentInfo;
            let skipConversion = false;

            if (
                fs.existsSync(outputDir) &&
                fs.existsSync(playlistPath) &&
                fs.existsSync(segmentInfoPath)
            ) {
                try {
                    // Load existing segment info
                    const savedSegmentInfo = JSON.parse(
                        fs.readFileSync(segmentInfoPath, "utf8")
                    );

                    // Verify all segment files still exist
                    const segmentFiles = savedSegmentInfo.segmentFiles || [];
                    const allSegmentsExist = segmentFiles.every((filename) =>
                        fs.existsSync(path.join(outputDir, filename))
                    );

                    if (allSegmentsExist && segmentFiles.length > 0) {
                        console.log(
                            `✅ Found existing conversion with ${segmentFiles.length} segments, skipping conversion`
                        );
                        segmentInfo = savedSegmentInfo;
                        skipConversion = true;
                        uploadSession.totalSegments = segmentInfo.totalSegments;
                    } else {
                        console.log(
                            `⚠️ Existing conversion incomplete, will reconvert`
                        );
                    }
                } catch (error) {
                    console.log(
                        `⚠️ Failed to load existing conversion info: ${error.message}`
                    );
                }
            }

            // Step 1: Convert to HLS segments
            if (!skipConversion) {
                segmentInfo = await this.convertToHLS(
                    filePath,
                    movieId,
                    videoInfo
                );
                uploadSession.totalSegments = segmentInfo.totalSegments;
            } else {
                uploadSession.status = "using_existing_conversion";
            }

            // Log resume information
            if (this.existingSegments.size > 0) {
                console.log(
                    `🔄 Resuming upload: ${this.existingSegments.size}/${segmentInfo.totalSegments} segments already exist`
                );
            }

            console.log(`Total segments: ${segmentInfo.totalSegments}`);
            console.log(`Segment duration: ${this.segmentDuration}s`);

            // Check if playlist files exist in S3
            this.playlistFilesExist = await this.checkPlaylistFilesExist(
                movieId
            );

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
                const chunk = data.toString();
                stderr += chunk;

                // Parse multiple progress indicators from FFmpeg output
                const lines = chunk.split("\n");

                for (const line of lines) {
                    // Look for progress lines that contain time= and speed=
                    if (line.includes("time=") && line.includes("speed=")) {
                        const timeMatch = line.match(
                            /time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/
                        );
                        const speedMatch = line.match(/speed=\s*(\d+\.?\d*)/);
                        const bitrateMatch = line.match(
                            /bitrate=\s*(\d+\.?\d*)/
                        );

                        if (timeMatch) {
                            const hours = parseInt(timeMatch[1]);
                            const minutes = parseInt(timeMatch[2]);
                            const seconds = parseInt(timeMatch[3]);
                            const milliseconds = parseInt(timeMatch[4]);
                            const currentTime =
                                hours * 3600 +
                                minutes * 60 +
                                seconds +
                                milliseconds / 100;
                            const totalTime = videoInfo.duration;

                            if (totalTime > 0) {
                                const progress = (
                                    (currentTime / totalTime) *
                                    100
                                ).toFixed(1);
                                const remainingTime = totalTime - currentTime;
                                const speed = speedMatch
                                    ? parseFloat(speedMatch[1])
                                    : 1;
                                const eta =
                                    speed > 0 ? remainingTime / speed : 0;

                                const formatTime = (seconds) => {
                                    const mins = Math.floor(seconds / 60);
                                    const secs = Math.floor(seconds % 60);
                                    return `${mins}:${secs
                                        .toString()
                                        .padStart(2, "0")}`;
                                };

                                const bitrate = bitrateMatch
                                    ? `${bitrateMatch[1]}kbps`
                                    : "N/A";
                                const speedStr =
                                    speed > 0 ? `${speed.toFixed(1)}x` : "N/A";

                                process.stdout.write(
                                    `\r🔄 Converting... ${formatTime(
                                        currentTime
                                    )}/${formatTime(
                                        totalTime
                                    )} (${progress}%) | Speed: ${speedStr} | ETA: ${formatTime(
                                        eta
                                    )} | Bitrate: ${bitrate}`
                                );
                            }
                        }
                    }
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

                    const segmentInfo = {
                        totalSegments,
                        outputDir,
                        playlistPath,
                        segmentFiles: segmentFiles.sort(),
                        convertedAt: new Date().toISOString(),
                        movieId: movieId,
                    };

                    // Save segment info for future reuse
                    const segmentInfoPath = path.join(
                        outputDir,
                        "segment-info.json"
                    );
                    fs.writeFileSync(
                        segmentInfoPath,
                        JSON.stringify(segmentInfo, null, 2)
                    );
                    console.log(`📝 Segment info saved to: segment-info.json`);

                    resolve(segmentInfo);
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

        // Check how many priority segments will actually be uploaded (not skipped)
        let actualPriorityUploads = 0;
        for (const filename of priorityFiles) {
            if (!this.existingSegments.has(filename)) {
                actualPriorityUploads++;
            }
        }

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

        // Upload playlist if we uploaded new segments OR if playlist files don't exist
        if (actualPriorityUploads > 0 || !this.playlistFilesExist) {
            // Upload initial playlist for priority segments
            await this.uploadPartialPlaylist(
                movieId,
                priorityFiles.length,
                segmentInfo
            );

            if (actualPriorityUploads > 0) {
                console.log(
                    `📝 Priority playlist uploaded (${actualPriorityUploads} new segments)`
                );
            } else {
                console.log(
                    `📝 Priority playlist uploaded (playlist files were missing)`
                );
            }
        } else {
            console.log(
                `⏭️  Skipping priority playlist upload (all ${priorityFiles.length} priority segments already existed and playlist files exist)`
            );
        }

        console.log(`✅ Priority segments processed. Ready for playback!`);

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

        // Define progress milestones
        // const progressMilestones = [0.25, 0.5, 0.75, 1.0];
        const progressMilestones = [0.5, 1.0];
        const completedMilestones = new Set();

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];

            // Track which segments in this batch actually get uploaded (not skipped)
            let actualUploadsInBatch = 0;

            const batchPromises = batch.map((filename, batchPos) => {
                const segmentIndex =
                    startIndex + batchIndex * this.concurrentUploads + batchPos;

                // Check if this segment will be skipped before calling uploadSegment
                const willBeSkipped = this.existingSegments.has(filename);
                if (!willBeSkipped) {
                    actualUploadsInBatch++;
                }

                return this.uploadSegment(
                    movieId,
                    filename,
                    segmentIndex,
                    uploadSession,
                    outputDir
                );
            });

            await Promise.all(batchPromises);

            const uploadedCount = Math.min(
                this.prioritySegments +
                    (batchIndex + 1) * this.concurrentUploads,
                uploadSession.totalSegments
            );

            // Calculate current progress
            const currentProgress = uploadedCount / uploadSession.totalSegments;

            // Determine if we should update playlist
            let shouldUpdatePlaylist = false;
            let updateReason = "";

            if (actualUploadsInBatch > 0) {
                // Always update if we uploaded new segments
                shouldUpdatePlaylist = true;
                updateReason = `${actualUploadsInBatch} new segments uploaded`;
            } else if (!this.playlistFilesExist) {
                // If playlist didn't exist originally, check for milestone progress
                for (const milestone of progressMilestones) {
                    if (
                        currentProgress >= milestone &&
                        !completedMilestones.has(milestone)
                    ) {
                        shouldUpdatePlaylist = true;
                        updateReason = `${(milestone * 100).toFixed(
                            0
                        )}% progress milestone reached`;
                        completedMilestones.add(milestone);
                        break; // Only trigger one milestone per batch
                    }
                }
            }

            if (shouldUpdatePlaylist) {
                await this.uploadPartialPlaylist(
                    movieId,
                    uploadedCount,
                    segmentInfo
                );
                console.log(
                    `📝 Playlist updated after batch ${
                        batchIndex + 1
                    } (${updateReason})`
                );
            } else {
                console.log(
                    `⏭️  Skipping playlist update for batch ${
                        batchIndex + 1
                    } (all segments already existed, no milestones reached)`
                );
            }
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
                "⏭️  Segment upload skipping disabled, will upload all segments"
            );
            return new Set();
        }

        try {
            console.log("🔍 Checking for existing uploaded segments...");

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
                    `📋 Found ${existingSegments.size} existing uploaded segments to skip`
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
                    "📋 No existing uploaded segments found, starting fresh upload"
                );
            }

            return existingSegments;
        } catch (error) {
            console.warn(
                "⚠️  Failed to check existing uploaded segments, will upload all:",
                error.message
            );
            return new Set();
        }
    }

    async checkPlaylistFilesExist(movieId) {
        try {
            console.log("🔍 Checking if playlist files exist...");

            const templateKey = `${this.playlistUploadPath}/${this.uploadSubpath}/movie/${movieId}/playlist-template.m3u8`;
            const playlistKey = `${this.playlistUploadPath}/${this.uploadSubpath}/movie/${movieId}/playlist.m3u8`;

            // Check template file
            const templateExists = await this.checkS3ObjectExists(
                this.playlistBucketName,
                templateKey
            );

            // Check main playlist file
            const playlistExists = await this.checkS3ObjectExists(
                this.playlistBucketName,
                playlistKey
            );

            console.log(
                `📋 Playlist files status: template=${templateExists}, playlist=${playlistExists}`
            );

            // Return true only if both files exist
            return templateExists && playlistExists;
        } catch (error) {
            console.warn(
                "⚠️  Failed to check playlist files existence:",
                error.message
            );
            // If we can't check, assume they don't exist to be safe
            return false;
        }
    }

    async checkS3ObjectExists(bucketName, key) {
        try {
            const { HeadObjectCommand } = require("@aws-sdk/client-s3");

            const command = new HeadObjectCommand({
                Bucket: bucketName,
                Key: key,
            });

            await this.s3Client.send(command);
            return true; // Object exists
        } catch (error) {
            if (
                error.name === "NotFound" ||
                error.$metadata?.httpStatusCode === 404
            ) {
                return false; // Object doesn't exist
            }
            // Re-throw other errors
            throw error;
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
