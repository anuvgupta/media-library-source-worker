// VideoHLSUploader/index.js

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { promisify } = require("util");
const { Upload } = require("@aws-sdk/lib-storage");

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

        // Optional parameters
        this.segmentDuration = options.segmentDuration || 10; // 10 second segments
        this.concurrentUploads = options.concurrentUploads || 3;
        this.prioritySegments = options.prioritySegments || 5; // Upload first N segments immediately
        this.tempDir = options.tempDir || "./temp";
        this.supportedFormats = [".mp4", ".mkv", ".avi", ".mov", ".m4v"];
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

            // Analyze video file
            const videoInfo = await this.analyzeVideoFile(filePath);
            console.log(
                `Video info: ${videoInfo.resolution}, ${videoInfo.videoCodec}, ${videoInfo.audioCodec}, ${videoInfo.duration}s`
            );

            // Create upload session
            const uploadSession = {
                movieId,
                totalSegments: 0,
                uploadedSegments: 0,
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
            playlist += `https://${this.websiteDomain}/${this.mediaUploadPath}/${this.uploadSubpath}/movie/${movieId}/segments/${filename}\n`;
        }

        // Only add end tag if all segments are uploaded
        const isComplete = segmentCount >= segmentInfo.totalSegments;
        if (isComplete) {
            playlist += "#EXT-X-ENDLIST\n";
        }

        const playlistParams = {
            Bucket: this.playlistBucketName,
            Key: `${this.playlistUploadPath}/${this.uploadSubpath}/movie/${movieId}/playlist.m3u8`,
            Body: playlist,
            ContentType: "application/vnd.apple.mpegurl",
            // // CRITICAL: Cache control for CDN compatibility
            // CacheControl: isComplete
            //     ? "public, max-age=3600" // Cache final playlist for 1 hour
            //     : "no-cache, no-store, must-revalidate", // Never cache partial playlists
            // Metadata: {
            //     movieId: movieId,
            //     segmentCount: segmentCount.toString(),
            //     totalSegments: segmentInfo.totalSegments.toString(),
            //     isComplete: isComplete.toString(),
            // },
        };

        const upload = new Upload({
            client: this.s3Client,
            params: playlistParams,
        });

        await upload.done();
        console.log(
            `📝 Playlist updated (${segmentCount}/${segmentInfo.totalSegments} segments)`
        );
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
            playlist += `https://${this.websiteDomain}/${this.mediaUploadPath}/${this.uploadSubpath}/movie/${movieId}/segments/${filename}\n`;
        }

        playlist += "#EXT-X-ENDLIST\n";

        const playlistParams = {
            Bucket: this.playlistBucketName,
            Key: `${this.playlistUploadPath}/${this.uploadSubpath}/movie/${movieId}/playlist.m3u8`,
            Body: playlist,
            ContentType: "application/vnd.apple.mpegurl",
            // // Final playlist can be cached longer
            // CacheControl: "public, max-age=86400", // Cache for 24 hours
            // Metadata: {
            //     movieId: movieId,
            //     totalSegments: segmentInfo.totalSegments.toString(),
            //     isComplete: "true",
            // },
        };

        const upload = new Upload({
            client: this.s3Client,
            params: playlistParams,
        });

        await upload.done();
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

module.exports = { VideoHLSUploader };
