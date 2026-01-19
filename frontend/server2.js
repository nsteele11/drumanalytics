import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";
import fs from "fs";
import { Readable } from "stream";
import { analyzeVideo } from "../analysis/analyze_video.js";
import { extractVideoSnapshot } from "../analysis/extract_snapshot.js";
import { generateStructuredOutputs } from "../analysis/performance_analysis.js";
import spotifyRoutes from "./spotifyRoutes.js";

dotenv.config();

// ----------------------
// ES Module Helpers
// ----------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------------------
// Upload Folder Setup
// ----------------------
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ----------------------
// Express Setup
// ----------------------
const app = express();
app.use(cors());
app.use(express.json()); // Parse JSON request bodies

const publicDir = path.join(__dirname, "public");
console.log("SERVER2 serving static files from:", publicDir);
app.use(express.static(publicDir));

// ----------------------
// Spotify Routes
// ----------------------
app.use("/api/spotify", spotifyRoutes);

// ----------------------
// AWS S3 Client
// ----------------------
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// ----------------------
// Helper: Download from S3
// ----------------------
async function downloadFromS3(key, localPath) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
  });

  const response = await s3.send(command);
  const stream = response.Body;

  await new Promise((resolve, reject) => {
    const write = fs.createWriteStream(localPath);
    stream.pipe(write);
    write.on("finish", resolve);
    write.on("error", reject);
  });
}

// ----------------------
// Multer Setup
// ----------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

// ----------------------
// Upload + Analysis Endpoint (ENHANCED)
// ----------------------
app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send("No file uploaded");
    }

    const file = req.file;
    const { artistId, trackId, artistName, trackName, videoType, spotifyMetadata } = req.body;

    if (!videoType) {
      return res.status(400).send("Video type must be selected");
    }

    // For Original type, require artistName and trackName
    if (videoType === 'Original') {
      if (!artistName || !trackName) {
        return res.status(400).send("Artist and track names are required for Original type");
      }
    } else {
      // For other types, require Spotify artistId and trackId
    if (!artistId || !trackId) {
        return res.status(400).send("Artist and track must be selected from Spotify");
      }
    }

    // ----------------------
    // Parse Spotify metadata (JSON string → object)
    // ----------------------
    let spotifyData = null;

    if (spotifyMetadata) {
      spotifyData = JSON.parse(spotifyMetadata);
    }

    console.log("Spotify metadata received:", spotifyData);

    // ----------------------
    // Normalize Spotify metadata
    // ----------------------
    const spotifyDataForStorage = spotifyData
      ? {
          artist: {
            id: spotifyData.artist.id,
            name: spotifyData.artist.name,
            genres: spotifyData.artist.genres,
            followers: spotifyData.artist.followers,
          },
          track: {
            id: spotifyData.track.id,
            name: spotifyData.track.name,
            album: spotifyData.track.album,
            release_date: spotifyData.track.release_date,
            popularity: spotifyData.track.popularity,
            duration_ms: spotifyData.track.duration_ms,
            album_image_url: spotifyData.track.album_image_url || null,
          },
          audio_features: spotifyData.audio_features || null,
        }
      : null;

    // ----------------------
    // Upload video to S3
    // ----------------------
    const s3Key = `${Date.now()}-${file.originalname}`;
    const fileContent = fs.readFileSync(file.path);

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: s3Key,
        Body: fileContent,
        ContentType: file.mimetype,
        Metadata: {
          spotify: spotifyDataForStorage
            ? Buffer.from(JSON.stringify(spotifyDataForStorage)).toString("base64")
            : "",
        },
      })
    );

    console.log("Uploaded video to S3:", s3Key);

    // ----------------------
    // Analyze video directly from local file (more efficient)
    // ----------------------
    console.log("Starting video analysis...");
    let analysis;
    try {
      analysis = await analyzeVideo(file.path);
      console.log("Analysis result:", analysis);
      if (analysis.bpm) {
        console.log(`BPM detected: ${analysis.bpm}`);
      }
    } catch (analysisError) {
      console.error("Video analysis error:", analysisError);
      // Clean up uploaded file from S3 if analysis fails
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: `failed-${s3Key}`,
            Body: JSON.stringify({ error: "Analysis failed", message: analysisError.message }),
            ContentType: "application/json",
          })
        );
      } catch (cleanupError) {
        console.error("Cleanup error:", cleanupError);
      }
      throw new Error(`Video analysis failed: ${analysisError.message}`);
    }

    // ----------------------
    // Extract video snapshot
    // ----------------------
    let snapshotKey = null;
    try {
      console.log("Extracting video snapshot...");
      const snapshotPath = path.join(uploadDir, `snapshot_${Date.now()}.jpg`);
      await extractVideoSnapshot(file.path, snapshotPath);
      
      // Upload snapshot to S3
      const snapshotContent = fs.readFileSync(snapshotPath);
      snapshotKey = `snapshots/${s3Key}.jpg`;
      
      await s3.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: snapshotKey,
          Body: snapshotContent,
          ContentType: "image/jpeg",
        })
      );
      
      console.log("Snapshot uploaded to S3:", snapshotKey);
      
      // Clean up local snapshot file
      try {
        fs.unlinkSync(snapshotPath);
      } catch (cleanupError) {
        console.warn("Failed to cleanup snapshot file:", cleanupError);
      }
    } catch (snapshotError) {
      console.warn("Snapshot extraction failed:", snapshotError.message);
      // Don't fail the upload if snapshot extraction fails
    }

    // ----------------------
    // Save analysis JSON locally
    // ----------------------
    const resultsDir = path.join(uploadDir, "results");
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    const localJsonPath = path.join(resultsDir, `${s3Key}.json`);

    const jsonData = {
      s3Key,
      originalFilename: file.originalname,
      videoType,
      analysis,
      analyzedAt: new Date().toISOString(),
      snapshotKey: snapshotKey || null,
    };

    // Add artist and track information based on type
    if (videoType === 'Original') {
      // For Original type, store free text names
      jsonData.artistName = artistName;
      jsonData.trackName = trackName;
      jsonData.spotify = null; // No Spotify data for Original
    } else {
      // For other types, store Spotify IDs and metadata
      jsonData.artistId = artistId;
      jsonData.trackId = trackId;
      jsonData.spotify = spotifyDataForStorage;
    }

    fs.writeFileSync(localJsonPath, JSON.stringify(jsonData, null, 2));

    // ----------------------
    // Upload analysis JSON to S3
    // ----------------------
    const analysisKey = `results/${s3Key}.json`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: analysisKey,
        Body: JSON.stringify(jsonData, null, 2),
        ContentType: "application/json",
      })
    );

    console.log("Analysis + metadata saved to S3:", analysisKey);

    // ----------------------
    // Cleanup local file
    // ----------------------
    try {
    fs.unlinkSync(file.path);
    } catch (cleanupError) {
      console.warn("Failed to delete local file:", cleanupError);
    }

    // ----------------------
    // Response
    // ----------------------
    res.json({
      message: "Upload complete; analytics and metadata saved",
      s3Key,
      spotify: spotifyDataForStorage,
    });
  } catch (err) {
    console.error("Upload or analysis error:", err);
    // Clean up uploaded file if it exists
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.warn("Failed to cleanup file:", cleanupError);
      }
    }
    res.status(500).json({ error: "Upload or analysis failed", message: err.message });
  }
});

// ----------------------
// List All Videos Endpoint
// ----------------------
app.get("/api/videos", async (req, res) => {
  try {
    // Validate environment variable
    if (!process.env.S3_BUCKET_NAME) {
      console.error("S3_BUCKET_NAME environment variable not set");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // List all objects in the S3 bucket
    const listCommand = new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: "results/", // Only get metadata files
    });

    const listResponse = await s3.send(listCommand);
    
    if (!listResponse.Contents || listResponse.Contents.length === 0) {
      return res.json([]);
    }

    // Fetch metadata for each video
    const allVideosData = []; // Store all video data first to calculate medians
    
    for (const obj of listResponse.Contents) {
      // Skip if it's not a JSON file
      if (!obj.Key || !obj.Key.endsWith('.json')) continue;
      
      try {
        // Extract s3Key from metadata filename (results/{s3Key}.json)
        const s3Key = obj.Key.replace('results/', '').replace('.json', '');
        
        // Verify that the video file exists before including it
        const headVideoCommand = new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: s3Key,
        });

        try {
          await s3.send(headVideoCommand);
          // Video file exists, proceed to get metadata
        } catch (headErr) {
          // Video file doesn't exist, skip this entry
          console.log(`Skipping ${obj.Key} - video file ${s3Key} does not exist`);
          continue;
        }

        // Get the metadata file
        const getMetadataCommand = new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: obj.Key,
        });

        const metadataResponse = await s3.send(getMetadataCommand);
        const metadataStream = metadataResponse.Body;
        
        // Convert stream to string - AWS SDK v3 returns a Readable stream
        const metadataText = await new Promise((resolve, reject) => {
          const chunks = [];
          metadataStream.on('data', (chunk) => chunks.push(chunk));
          metadataStream.on('end', () => {
            try {
              resolve(Buffer.concat(chunks).toString('utf-8'));
            } catch (err) {
              reject(err);
            }
          });
          metadataStream.on('error', reject);
        });

        const metadata = JSON.parse(metadataText);
        
        // Ensure we're using the most recent metrics from the metadata file
        // The metadata file always contains the latest metrics values (updated when metrics are saved)
        // metricsHistory is for tracking changes, but the root-level metrics are always current
        let latestMetrics = {
          igViews: metadata.igViews || null,
          igLikes: metadata.igLikes || null,
          tiktokViews: metadata.tiktokViews || null,
          tiktokLikes: metadata.tiktokLikes || null,
          igHashtags: metadata.igHashtags || null,
          tiktokHashtags: metadata.tiktokHashtags || null,
          postedDate: metadata.postedDate || null,
          metricsUpdatedAt: metadata.metricsUpdatedAt || null
        };
        
        // Verify against history if it exists (safety check - metadata should always be most recent)
        if (metadata.metricsHistory && metadata.metricsHistory.length > 0) {
          const mostRecentHistory = metadata.metricsHistory[0];
          if (mostRecentHistory.current && mostRecentHistory.timestamp) {
            const historyTimestamp = new Date(mostRecentHistory.timestamp);
            const metadataTimestamp = metadata.metricsUpdatedAt ? new Date(metadata.metricsUpdatedAt) : null;
            
            // If history timestamp is more recent than metadata timestamp, use history (shouldn't happen, but safety check)
            if (!metadataTimestamp || historyTimestamp > metadataTimestamp) {
              latestMetrics = {
                igViews: mostRecentHistory.current.igViews !== undefined ? mostRecentHistory.current.igViews : latestMetrics.igViews,
                igLikes: mostRecentHistory.current.igLikes !== undefined ? mostRecentHistory.current.igLikes : latestMetrics.igLikes,
                tiktokViews: mostRecentHistory.current.tiktokViews !== undefined ? mostRecentHistory.current.tiktokViews : latestMetrics.tiktokViews,
                tiktokLikes: mostRecentHistory.current.tiktokLikes !== undefined ? mostRecentHistory.current.tiktokLikes : latestMetrics.tiktokLikes,
                igHashtags: mostRecentHistory.current.igHashtags !== undefined ? mostRecentHistory.current.igHashtags : latestMetrics.igHashtags,
                tiktokHashtags: mostRecentHistory.current.tiktokHashtags !== undefined ? mostRecentHistory.current.tiktokHashtags : latestMetrics.tiktokHashtags,
                postedDate: mostRecentHistory.current.postedDate !== undefined ? mostRecentHistory.current.postedDate : latestMetrics.postedDate,
                metricsUpdatedAt: mostRecentHistory.timestamp
              };
            }
          }
        }
        
        // Extract video info - handle both Original type (free text) and Spotify-linked videos
        const videoInfo = {
          s3Key: metadata.s3Key || s3Key,
          originalFilename: metadata.originalFilename,
          videoType: metadata.videoType || null,
          artistName: metadata.artistName || metadata.spotify?.artist?.name || 'Unknown Artist',
          trackName: metadata.trackName || metadata.spotify?.track?.name || 'Unknown Track',
          album: metadata.spotify?.track?.album || null,
          releaseDate: metadata.spotify?.track?.release_date || null,
          popularity: metadata.spotify?.track?.popularity || null,
          artistFollowers: metadata.spotify?.artist?.followers || null,
          genres: metadata.spotify?.artist?.genres || [],
          albumImageUrl: metadata.spotify?.track?.album_image_url || null,
          snapshotKey: metadata.snapshotKey || null,
          analyzedAt: metadata.analyzedAt || null,
          uploadTimestamp: metadata.s3Key ? parseInt(metadata.s3Key.split('-')[0]) : null,
          // Social media metrics - always use the most recent values
          igHashtags: latestMetrics.igHashtags,
          tiktokHashtags: latestMetrics.tiktokHashtags,
          igViews: latestMetrics.igViews,
          igLikes: latestMetrics.igLikes,
          tiktokViews: latestMetrics.tiktokViews,
          tiktokLikes: latestMetrics.tiktokLikes,
          postedDate: latestMetrics.postedDate,
          metricsUpdatedAt: latestMetrics.metricsUpdatedAt,
          // Include analysis data if available
          duration: metadata.analysis?.duration || null,
          size_mb: metadata.analysis?.size_mb || null,
          resolution: metadata.analysis?.video ? `${metadata.analysis.video.width}x${metadata.analysis.video.height}` : null,
          videoCodec: metadata.analysis?.video?.codec || null,
          fps: metadata.analysis?.video?.fps || null,
          audioCodec: metadata.analysis?.audio?.codec || null,
          sampleRate: metadata.analysis?.audio?.sample_rate || null,
          bpm: metadata.analysis?.bpm || null,
          pitch: metadata.analysis?.pitch || null,
          pitchConfidence: metadata.analysis?.pitchConfidence || null,
          onsets: metadata.analysis?.onsets || null,
          onsetRate: metadata.analysis?.onsetRate || null,
          energy: metadata.analysis?.energy || null,
          silenceRatio: metadata.analysis?.silenceRatio || null,
          tempoSpikes: metadata.analysis?.tempoSpikes || null,
          volumeSpikes: metadata.analysis?.volumeSpikes || null,
          unusualPatterns: metadata.analysis?.unusualPatterns || null,
          shockValue: metadata.analysis?.shockValue || null,
        };

        allVideosData.push(videoInfo);
      } catch (err) {
        console.error(`Error processing metadata for ${obj.Key}:`, err);
        // Continue with next video
      }
    }

    // Calculate success scores and ranks for all videos
    // First, calculate medians for normalization
    const igViewsValues = allVideosData
      .filter(v => v.igViews !== null && v.igViews !== undefined && v.igViews > 0)
      .map(v => v.igViews);
    const igLikesValues = allVideosData
      .filter(v => v.igLikes !== null && v.igLikes !== undefined && v.igLikes > 0)
      .map(v => v.igLikes);
    const tiktokViewsValues = allVideosData
      .filter(v => v.tiktokViews !== null && v.tiktokViews !== undefined && v.tiktokViews > 0)
      .map(v => v.tiktokViews);
    const tiktokLikesValues = allVideosData
      .filter(v => v.tiktokLikes !== null && v.tiktokLikes !== undefined && v.tiktokLikes > 0)
      .map(v => v.tiktokLikes);

    const calculateMedian = (values) => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    };

    const igViewsMedian = calculateMedian(igViewsValues);
    const igLikesMedian = calculateMedian(igLikesValues);
    const tiktokViewsMedian = calculateMedian(tiktokViewsValues);
    const tiktokLikesMedian = calculateMedian(tiktokLikesValues);

    // Calculate engagement rate medians (likes/views)
    const igEngagementRates = allVideosData
      .filter(v => v.igViews > 0 && v.igLikes !== null && v.igLikes !== undefined && v.igLikes >= 0)
      .map(v => v.igLikes / v.igViews);
    const tiktokEngagementRates = allVideosData
      .filter(v => v.tiktokViews > 0 && v.tiktokLikes !== null && v.tiktokLikes !== undefined && v.tiktokLikes >= 0)
      .map(v => v.tiktokLikes / v.tiktokViews);

    const igEngagementMedian = calculateMedian(igEngagementRates);
    const tiktokEngagementMedian = calculateMedian(tiktokEngagementRates);

    // Calculate success score for each video
    // Equally weight all available metrics: views, likes, and engagement rate (likes/views)
    allVideosData.forEach(video => {
      const metrics = [];
      let hasMetrics = false;

      // IG metrics
      if (video.igViews !== null && video.igViews !== undefined && video.igViews > 0) {
        hasMetrics = true;
        // Views score (normalized to median)
        if (igViewsMedian > 0) {
          const viewsRatio = Math.min(video.igViews / igViewsMedian, 2); // Cap at 2x median
          metrics.push(viewsRatio);
        }
        
        // Likes score (normalized to median)
        if (video.igLikes !== null && video.igLikes !== undefined && video.igLikes >= 0 && igLikesMedian > 0) {
          const likesRatio = Math.min(video.igLikes / igLikesMedian, 2); // Cap at 2x median
          metrics.push(likesRatio);
        }
        
        // Engagement rate score (likes/views, normalized to median engagement rate)
        if (video.igLikes !== null && video.igLikes !== undefined && video.igLikes >= 0 && 
            video.igViews > 0 && igEngagementMedian > 0) {
          const engagementRate = video.igLikes / video.igViews;
          const engagementRatio = Math.min(engagementRate / igEngagementMedian, 2); // Cap at 2x median
          metrics.push(engagementRatio);
        }
      }

      // TikTok metrics
      if (video.tiktokViews !== null && video.tiktokViews !== undefined && video.tiktokViews > 0) {
        hasMetrics = true;
        // Views score (normalized to median)
        if (tiktokViewsMedian > 0) {
          const viewsRatio = Math.min(video.tiktokViews / tiktokViewsMedian, 2); // Cap at 2x median
          metrics.push(viewsRatio);
        }
        
        // Likes score (normalized to median)
        if (video.tiktokLikes !== null && video.tiktokLikes !== undefined && video.tiktokLikes >= 0 && tiktokLikesMedian > 0) {
          const likesRatio = Math.min(video.tiktokLikes / tiktokLikesMedian, 2); // Cap at 2x median
          metrics.push(likesRatio);
        }
        
        // Engagement rate score (likes/views, normalized to median engagement rate)
        if (video.tiktokLikes !== null && video.tiktokLikes !== undefined && video.tiktokLikes >= 0 && 
            video.tiktokViews > 0 && tiktokEngagementMedian > 0) {
          const engagementRate = video.tiktokLikes / video.tiktokViews;
          const engagementRatio = Math.min(engagementRate / tiktokEngagementMedian, 2); // Cap at 2x median
          metrics.push(engagementRatio);
        }
      }

      // Calculate success score: equally weight all metrics
      if (hasMetrics && metrics.length > 0) {
        // Average all metrics and scale to 0-100
        const avgRatio = metrics.reduce((sum, ratio) => sum + ratio, 0) / metrics.length;
        // Scale: if avgRatio is 1.0 (at median), score is 50. If avgRatio is 2.0 (2x median), score is 100.
        // Linear scaling: score = (avgRatio / 2.0) * 100, capped at 100
        video.successScore = Math.min(Math.round((avgRatio / 2.0) * 100), 100);
      } else {
        video.successScore = null;
      }
    });

    // Calculate ranks based on success score
    const videosWithScores = allVideosData.filter(v => v.successScore !== null && v.successScore !== undefined);
    videosWithScores.sort((a, b) => b.successScore - a.successScore);
    
    // Assign ranks (lower rank number = better, rank 1 is best)
    videosWithScores.forEach((video, index) => {
      video.successRank = index + 1;
    });

    // Set rank to null for videos without scores
    allVideosData.forEach(video => {
      if (video.successScore === null || video.successScore === undefined) {
        video.successRank = null;
      }
    });

    // Use allVideosData as videos (they now have success scores and ranks)
    const videos = allVideosData;

    // Sort by posted date (newest first), fallback to upload timestamp if no posted date
    videos.sort((a, b) => {
      let aDate, bDate;
      
      if (a.postedDate) {
        // If it's in YYYY-MM-DD format, parse it as local date to avoid timezone issues
        if (/^\d{4}-\d{2}-\d{2}$/.test(a.postedDate)) {
          aDate = new Date(a.postedDate + 'T12:00:00').getTime(); // Use noon to avoid timezone edge cases
        } else {
          aDate = new Date(a.postedDate).getTime();
        }
      } else {
        aDate = a.uploadTimestamp || 0;
      }
      
      if (b.postedDate) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(b.postedDate)) {
          bDate = new Date(b.postedDate + 'T12:00:00').getTime();
        } else {
          bDate = new Date(b.postedDate).getTime();
        }
      } else {
        bDate = b.uploadTimestamp || 0;
      }
      
      return bDate - aDate;
    });

    res.json(videos);
  } catch (err) {
    console.error("Error listing videos:", err);
    res.status(500).json({ error: "Failed to list videos" });
  }
});

// ----------------------
// Get Video Playback URL Endpoint
// ----------------------
app.get("/api/videos/:s3Key/play", async (req, res) => {
  try {
    const { s3Key } = req.params;
    
    if (!s3Key) {
      return res.status(400).json({ error: "Video key is required" });
    }

    if (!process.env.S3_BUCKET_NAME) {
      console.error("S3_BUCKET_NAME environment variable not set");
      return res.status(500).json({ error: "Server configuration error" });
    }
    
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key,
    });

    // Generate a signed URL that expires in 1 hour
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    
    res.json({ url: signedUrl });
  } catch (err) {
    console.error("Error generating video URL:", err);
    res.status(500).json({ error: "Failed to generate video URL", message: err.message });
  }
});

// ----------------------
// Get Snapshot Image URL Endpoint
// ----------------------
app.get("/api/videos/:s3Key/snapshot", async (req, res) => {
  try {
    const { s3Key } = req.params;
    
    if (!s3Key) {
      return res.status(400).json({ error: "Video key is required" });
    }

    if (!process.env.S3_BUCKET_NAME) {
      console.error("S3_BUCKET_NAME environment variable not set");
      return res.status(500).json({ error: "Server configuration error" });
    }
    
    const snapshotKey = `snapshots/${s3Key}.jpg`;
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: snapshotKey,
    });

    // Generate a signed URL that expires in 1 hour
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    
    res.json({ url: signedUrl });
  } catch (err) {
    console.error("Error generating snapshot URL:", err);
    res.status(500).json({ error: "Failed to generate snapshot URL", message: err.message });
  }
});

// ----------------------
// Update Video Metrics Endpoint
// ----------------------
app.put("/api/videos/:s3Key/metrics", async (req, res) => {
  try {
    const { s3Key } = req.params;
    const { igHashtags, tiktokHashtags, igViews, igLikes, tiktokViews, tiktokLikes, postedDate } = req.body;
    
    if (!s3Key) {
      return res.status(400).json({ error: "Video key is required" });
    }

    if (!process.env.S3_BUCKET_NAME) {
      console.error("S3_BUCKET_NAME environment variable not set");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Get the existing metadata file
    const metadataKey = `results/${s3Key}.json`;
    const getMetadataCommand = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: metadataKey,
    });

    let metadata;
    try {
      const metadataResponse = await s3.send(getMetadataCommand);
      const metadataStream = metadataResponse.Body;
      
      // Convert stream to string
      const metadataText = await new Promise((resolve, reject) => {
        const chunks = [];
        metadataStream.on('data', (chunk) => chunks.push(chunk));
        metadataStream.on('end', () => {
          try {
            resolve(Buffer.concat(chunks).toString('utf-8'));
          } catch (err) {
            reject(err);
          }
        });
        metadataStream.on('error', reject);
      });

      metadata = JSON.parse(metadataText);
    } catch (err) {
      console.error("Error fetching metadata:", err);
      return res.status(404).json({ error: "Video metadata not found" });
    }

    // Capture previous values for history tracking
    const previousMetrics = {
      igHashtags: metadata.igHashtags || null,
      tiktokHashtags: metadata.tiktokHashtags || null,
      igViews: metadata.igViews !== undefined && metadata.igViews !== null ? Number(metadata.igViews) : null,
      igLikes: metadata.igLikes !== undefined && metadata.igLikes !== null ? Number(metadata.igLikes) : null,
      tiktokViews: metadata.tiktokViews !== undefined && metadata.tiktokViews !== null ? Number(metadata.tiktokViews) : null,
      tiktokLikes: metadata.tiktokLikes !== undefined && metadata.tiktokLikes !== null ? Number(metadata.tiktokLikes) : null,
      postedDate: metadata.postedDate || null
    };

    // Get new values
    const newIgViews = igViews !== undefined && igViews !== null ? Number(igViews) : null;
    const newIgLikes = igLikes !== undefined && igLikes !== null ? Number(igLikes) : null;
    const newTiktokViews = tiktokViews !== undefined && tiktokViews !== null ? Number(tiktokViews) : null;
    const newTiktokLikes = tiktokLikes !== undefined && tiktokLikes !== null ? Number(tiktokLikes) : null;

    // Detect changes
    const changes = {};
    if (previousMetrics.igViews !== newIgViews) changes.igViews = { from: previousMetrics.igViews, to: newIgViews };
    if (previousMetrics.igLikes !== newIgLikes) changes.igLikes = { from: previousMetrics.igLikes, to: newIgLikes };
    if (previousMetrics.tiktokViews !== newTiktokViews) changes.tiktokViews = { from: previousMetrics.tiktokViews, to: newTiktokViews };
    if (previousMetrics.tiktokLikes !== newTiktokLikes) changes.tiktokLikes = { from: previousMetrics.tiktokLikes, to: newTiktokLikes };
    if (previousMetrics.igHashtags !== (igHashtags || null)) changes.igHashtags = { from: previousMetrics.igHashtags, to: (igHashtags || null) };
    if (previousMetrics.tiktokHashtags !== (tiktokHashtags || null)) changes.tiktokHashtags = { from: previousMetrics.tiktokHashtags, to: (tiktokHashtags || null) };
    if (previousMetrics.postedDate !== (postedDate || null)) changes.postedDate = { from: previousMetrics.postedDate, to: (postedDate || null) };

    // Initialize metricsHistory if it doesn't exist
    if (!metadata.metricsHistory) {
      metadata.metricsHistory = [];
    }

    // Only create history entry if there are actual changes
    if (Object.keys(changes).length > 0) {
      const historyEntry = {
        timestamp: new Date().toISOString(),
        previous: previousMetrics,
        current: {
          igHashtags: igHashtags || null,
          tiktokHashtags: tiktokHashtags || null,
          igViews: newIgViews,
          igLikes: newIgLikes,
          tiktokViews: newTiktokViews,
          tiktokLikes: newTiktokLikes,
          postedDate: postedDate || null
        },
        changes: changes
      };

      // Add to history (most recent first)
      metadata.metricsHistory.unshift(historyEntry);

      // Limit history to last 50 entries to prevent unbounded growth
      if (metadata.metricsHistory.length > 50) {
        metadata.metricsHistory = metadata.metricsHistory.slice(0, 50);
      }
    }

    // Update the metrics
    metadata.igHashtags = igHashtags || null;
    metadata.tiktokHashtags = tiktokHashtags || null;
    metadata.igViews = newIgViews;
    metadata.igLikes = newIgLikes;
    metadata.tiktokViews = newTiktokViews;
    metadata.tiktokLikes = newTiktokLikes;
    metadata.postedDate = postedDate || null;
    metadata.metricsUpdatedAt = new Date().toISOString();

    // Save updated metadata back to S3
    const putMetadataCommand = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: metadataKey,
      Body: JSON.stringify(metadata, null, 2),
      ContentType: "application/json",
    });

    await s3.send(putMetadataCommand);

    console.log(`Updated metrics for video: ${s3Key}`);
    
    res.json({ 
      message: "Metrics updated successfully", 
      s3Key,
      metrics: {
        igHashtags: metadata.igHashtags,
        tiktokHashtags: metadata.tiktokHashtags,
        igViews: metadata.igViews,
        igLikes: metadata.igLikes,
        tiktokViews: metadata.tiktokViews,
        tiktokLikes: metadata.tiktokLikes,
        postedDate: metadata.postedDate,
        metricsUpdatedAt: metadata.metricsUpdatedAt
      },
      historyEntry: Object.keys(changes).length > 0 ? {
        timestamp: metadata.metricsHistory[0].timestamp,
        changes: changes
      } : null,
      totalHistoryEntries: metadata.metricsHistory ? metadata.metricsHistory.length : 0
    });
  } catch (err) {
    console.error("Error updating video metrics:", err);
    res.status(500).json({ error: "Failed to update metrics", message: err.message });
  }
});

// ----------------------
// Get Video Metrics History Endpoint
// ----------------------
app.get("/api/videos/:s3Key/metrics-history", async (req, res) => {
  try {
    const { s3Key } = req.params;
    
    if (!s3Key) {
      return res.status(400).json({ error: "Video key is required" });
    }

    if (!process.env.S3_BUCKET_NAME) {
      console.error("S3_BUCKET_NAME environment variable not set");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Get the existing metadata file
    const metadataKey = `results/${s3Key}.json`;
    const getMetadataCommand = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: metadataKey,
    });

    let metadata;
    try {
      const metadataResponse = await s3.send(getMetadataCommand);
      const metadataStream = metadataResponse.Body;
      
      // Convert stream to string
      const metadataText = await new Promise((resolve, reject) => {
        const chunks = [];
        metadataStream.on('data', (chunk) => chunks.push(chunk));
        metadataStream.on('end', () => {
          try {
            resolve(Buffer.concat(chunks).toString('utf-8'));
          } catch (err) {
            reject(err);
          }
        });
        metadataStream.on('error', reject);
      });

      metadata = JSON.parse(metadataText);
    } catch (err) {
      console.error("Error fetching metadata:", err);
      return res.status(404).json({ error: "Video metadata not found" });
    }

    // Return metrics history
    const history = metadata.metricsHistory || [];
    
    res.json({
      s3Key,
      trackName: metadata.trackName || metadata.spotify?.track?.name || 'Unknown',
      artistName: metadata.artistName || metadata.spotify?.artist?.name || 'Unknown',
      currentMetrics: {
        igHashtags: metadata.igHashtags || null,
        tiktokHashtags: metadata.tiktokHashtags || null,
        igViews: metadata.igViews || null,
        igLikes: metadata.igLikes || null,
        tiktokViews: metadata.tiktokViews || null,
        tiktokLikes: metadata.tiktokLikes || null,
        postedDate: metadata.postedDate || null,
        metricsUpdatedAt: metadata.metricsUpdatedAt || null
      },
      history: history,
      totalHistoryEntries: history.length
    });
  } catch (err) {
    console.error("Error fetching metrics history:", err);
    res.status(500).json({ error: "Failed to fetch metrics history", message: err.message });
  }
});

// ----------------------
// Get Hashtag Suggestions Endpoint
// ----------------------
app.get("/api/videos/:s3Key/hashtag-suggestions", async (req, res) => {
  try {
    const { s3Key } = req.params;
    
    if (!s3Key) {
      return res.status(400).json({ error: "Video key is required" });
    }

    if (!process.env.S3_BUCKET_NAME) {
      console.error("S3_BUCKET_NAME environment variable not set");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Get the current video's metadata
    const metadataKey = `results/${s3Key}.json`;
    const getMetadataCommand = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: metadataKey,
    });

    let currentVideo;
    try {
      const metadataResponse = await s3.send(getMetadataCommand);
      const metadataStream = metadataResponse.Body;
      
      const metadataText = await new Promise((resolve, reject) => {
        const chunks = [];
        metadataStream.on('data', (chunk) => chunks.push(chunk));
        metadataStream.on('end', () => {
          try {
            resolve(Buffer.concat(chunks).toString('utf-8'));
          } catch (err) {
            reject(err);
          }
        });
        metadataStream.on('error', reject);
      });

      currentVideo = JSON.parse(metadataText);
    } catch (err) {
      console.error("Error fetching current video metadata:", err);
      return res.status(404).json({ error: "Video metadata not found" });
    }

    // Get all videos to analyze historical performance
    const listCommand = new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: "results/",
    });

    const listResponse = await s3.send(listCommand);
    const allVideos = [];

    if (listResponse.Contents) {
      for (const obj of listResponse.Contents) {
        if (obj.Key.endsWith('.json')) {
          try {
            const getObjCommand = new GetObjectCommand({
              Bucket: process.env.S3_BUCKET_NAME,
              Key: obj.Key,
            });

            const objResponse = await s3.send(getObjCommand);
            const objStream = objResponse.Body;
            
            const objText = await new Promise((resolve, reject) => {
              const chunks = [];
              objStream.on('data', (chunk) => chunks.push(chunk));
              objStream.on('end', () => {
                try {
                  resolve(Buffer.concat(chunks).toString('utf-8'));
                } catch (err) {
                  reject(err);
                }
              });
              objStream.on('error', reject);
            });

            const videoData = JSON.parse(objText);
            allVideos.push(videoData);
          } catch (err) {
            console.warn(`Error reading video metadata ${obj.Key}:`, err.message);
          }
        }
      }
    }

    // Generate hashtag suggestions
    const suggestions = generateHashtagSuggestions(currentVideo, allVideos);

    res.json(suggestions);
  } catch (err) {
    console.error("Error generating hashtag suggestions:", err);
    res.status(500).json({ error: "Failed to generate suggestions", message: err.message });
  }
});

// ----------------------
// Performance Analysis Endpoint
// ----------------------
app.get("/api/performance-analysis", async (req, res) => {
  try {
    if (!process.env.S3_BUCKET_NAME) {
      console.error("S3_BUCKET_NAME environment variable not set");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Get all videos
    const listCommand = new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_NAME,
      Prefix: "results/",
    });

    const listResponse = await s3.send(listCommand);
    
    if (!listResponse.Contents || listResponse.Contents.length === 0) {
      return res.json({
        error: "No videos found",
        early_signal_summary: [],
        what_seems_working: [],
        per_video_comparison: []
      });
    }

    // Fetch metadata for each video
    const videos = [];
    
    for (const obj of listResponse.Contents) {
      if (!obj.Key || !obj.Key.endsWith('.json')) continue;
      
      try {
        const getMetadataCommand = new GetObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME,
          Key: obj.Key,
        });

        const metadataResponse = await s3.send(getMetadataCommand);
        const metadataStream = metadataResponse.Body;
        
        const metadataText = await new Promise((resolve, reject) => {
          const chunks = [];
          metadataStream.on('data', (chunk) => chunks.push(chunk));
          metadataStream.on('end', () => {
            try {
              resolve(Buffer.concat(chunks).toString('utf-8'));
            } catch (err) {
              reject(err);
            }
          });
          metadataStream.on('error', reject);
        });

        const metadata = JSON.parse(metadataText);
        
        // Ensure we're using the most recent metrics
        // If metricsHistory exists, verify we're using the latest values
        let latestMetrics = {
          igViews: metadata.igViews || null,
          igLikes: metadata.igLikes || null,
          tiktokViews: metadata.tiktokViews || null,
          tiktokLikes: metadata.tiktokLikes || null,
          igHashtags: metadata.igHashtags || null,
          tiktokHashtags: metadata.tiktokHashtags || null,
          postedDate: metadata.postedDate || null,
          metricsUpdatedAt: metadata.metricsUpdatedAt || null
        };
        
        // If metricsHistory exists and has entries, verify the current metrics match the most recent history entry
        if (metadata.metricsHistory && metadata.metricsHistory.length > 0) {
          const mostRecentHistory = metadata.metricsHistory[0];
          // Use the most recent history entry's current values if they're more recent
          if (mostRecentHistory.current && mostRecentHistory.timestamp) {
            const historyTimestamp = new Date(mostRecentHistory.timestamp);
            const metadataTimestamp = metadata.metricsUpdatedAt ? new Date(metadata.metricsUpdatedAt) : null;
            
            // If history is more recent, use history values (though metadata should always be updated)
            if (!metadataTimestamp || historyTimestamp > metadataTimestamp) {
              latestMetrics = {
                igViews: mostRecentHistory.current.igViews !== undefined ? mostRecentHistory.current.igViews : latestMetrics.igViews,
                igLikes: mostRecentHistory.current.igLikes !== undefined ? mostRecentHistory.current.igLikes : latestMetrics.igLikes,
                tiktokViews: mostRecentHistory.current.tiktokViews !== undefined ? mostRecentHistory.current.tiktokViews : latestMetrics.tiktokViews,
                tiktokLikes: mostRecentHistory.current.tiktokLikes !== undefined ? mostRecentHistory.current.tiktokLikes : latestMetrics.tiktokLikes,
                igHashtags: mostRecentHistory.current.igHashtags !== undefined ? mostRecentHistory.current.igHashtags : latestMetrics.igHashtags,
                tiktokHashtags: mostRecentHistory.current.tiktokHashtags !== undefined ? mostRecentHistory.current.tiktokHashtags : latestMetrics.tiktokHashtags,
                postedDate: mostRecentHistory.current.postedDate !== undefined ? mostRecentHistory.current.postedDate : latestMetrics.postedDate,
                metricsUpdatedAt: mostRecentHistory.timestamp
              };
            }
          }
        }
        
        // Map to the format expected by the analysis module
        const videoData = {
          s3Key: metadata.s3Key || obj.Key.replace('results/', '').replace('.json', ''),
          originalFilename: metadata.originalFilename,
          videoType: metadata.videoType || null,
          artistName: metadata.artistName || metadata.spotify?.artist?.name || 'Unknown Artist',
          trackName: metadata.trackName || metadata.spotify?.track?.name || 'Unknown Track',
          album: metadata.spotify?.track?.album || null,
          releaseDate: metadata.spotify?.track?.release_date || null,
          popularity: metadata.spotify?.track?.popularity || null,
          artistFollowers: metadata.spotify?.artist?.followers || null,
          genres: metadata.spotify?.artist?.genres || [],
          albumImageUrl: metadata.spotify?.track?.album_image_url || null,
          snapshotKey: metadata.snapshotKey || null,
          analyzedAt: metadata.analyzedAt || null,
          uploadTimestamp: metadata.s3Key ? parseInt(metadata.s3Key.split('-')[0]) : null,
          // Social media metrics - always use the most recent values
          igHashtags: latestMetrics.igHashtags,
          tiktokHashtags: latestMetrics.tiktokHashtags,
          igViews: latestMetrics.igViews,
          igLikes: latestMetrics.igLikes,
          tiktokViews: latestMetrics.tiktokViews,
          tiktokLikes: latestMetrics.tiktokLikes,
          postedDate: latestMetrics.postedDate,
          metricsUpdatedAt: latestMetrics.metricsUpdatedAt,
          // Analysis data
          duration: metadata.analysis?.duration || null,
          size_mb: metadata.analysis?.size_mb || null,
          resolution: metadata.analysis?.video ? `${metadata.analysis.video.width}x${metadata.analysis.video.height}` : null,
          videoCodec: metadata.analysis?.video?.codec || null,
          fps: metadata.analysis?.video?.fps || null,
          audioCodec: metadata.analysis?.audio?.codec || null,
          sampleRate: metadata.analysis?.audio?.sample_rate || null,
          bpm: metadata.analysis?.bpm || null,
          pitch: metadata.analysis?.pitch || null,
          pitchConfidence: metadata.analysis?.pitchConfidence || null,
          onsets: metadata.analysis?.onsets || null,
          onsetRate: metadata.analysis?.onsetRate || null,
          energy: metadata.analysis?.energy || null,
          silenceRatio: metadata.analysis?.silenceRatio || null,
          tempoSpikes: metadata.analysis?.tempoSpikes || null,
          volumeSpikes: metadata.analysis?.volumeSpikes || null,
          unusualPatterns: metadata.analysis?.unusualPatterns || null,
          shockValue: metadata.analysis?.shockValue || null,
        };

        videos.push(videoData);
      } catch (err) {
        console.error(`Error processing metadata for ${obj.Key}:`, err);
        // Continue with next video
      }
    }

    // Run performance analysis
    const analysisResults = generateStructuredOutputs(videos);
    
    res.json(analysisResults);
  } catch (err) {
    console.error("Error performing analysis:", err);
    res.status(500).json({ error: "Failed to perform analysis", message: err.message });
  }
});

// ----------------------
// Hashtag Suggestion Algorithm
// ----------------------
function generateHashtagSuggestions(currentVideo, allVideos) {
  const artistName = currentVideo.artistName || currentVideo.spotify?.artist?.name || '';
  const trackName = currentVideo.trackName || currentVideo.spotify?.track?.name || '';
  const genres = currentVideo.spotify?.artist?.genres || [];

  // Build a set of all other artist names to exclude from suggestions
  const otherArtistNames = new Set();
  allVideos.forEach(video => {
    if (video.s3Key === currentVideo.s3Key) return;
    const otherArtist = video.artistName || video.spotify?.artist?.name || '';
    if (otherArtist && otherArtist.toLowerCase() !== artistName.toLowerCase()) {
      otherArtistNames.add(normalizeForHashtag(otherArtist).toLowerCase());
    }
  });

  // Extract and normalize hashtags from historical data for validation/scoring only
  const hashtagPerformance = new Map(); // hashtag -> { igViews, igLikes, tiktokViews, tiktokLikes, count }

  allVideos.forEach(video => {
    // Skip current video
    if (video.s3Key === currentVideo.s3Key) return;

    // Analyze Instagram hashtags
    if (video.igHashtags) {
      const igTags = extractHashtags(video.igHashtags);
      const igEngagement = calculateEngagement(video.igViews, video.igLikes);
      
      igTags.forEach(tag => {
        // Skip if this tag matches another artist name
        if (otherArtistNames.has(tag)) return;
        
        if (!hashtagPerformance.has(tag)) {
          hashtagPerformance.set(tag, { igViews: 0, igLikes: 0, tiktokViews: 0, tiktokLikes: 0, count: 0, igEngagement: 0, tiktokEngagement: 0 });
        }
        const perf = hashtagPerformance.get(tag);
        perf.igViews += (video.igViews || 0);
        perf.igLikes += (video.igLikes || 0);
        perf.count += 1;
        perf.igEngagement += igEngagement;
      });
    }

    // Analyze TikTok hashtags
    if (video.tiktokHashtags) {
      const tiktokTags = extractHashtags(video.tiktokHashtags);
      const tiktokEngagement = calculateEngagement(video.tiktokViews, video.tiktokLikes);
      
      tiktokTags.forEach(tag => {
        // Skip if this tag matches another artist name
        if (otherArtistNames.has(tag)) return;
        
        if (!hashtagPerformance.has(tag)) {
          hashtagPerformance.set(tag, { igViews: 0, igLikes: 0, tiktokViews: 0, tiktokLikes: 0, count: 0, igEngagement: 0, tiktokEngagement: 0 });
        }
        const perf = hashtagPerformance.get(tag);
        perf.tiktokViews += (video.tiktokViews || 0);
        perf.tiktokLikes += (video.tiktokLikes || 0);
        perf.count += 1;
        perf.tiktokEngagement += tiktokEngagement;
      });
    }
  });

  // Calculate average engagement per hashtag
  hashtagPerformance.forEach((perf, tag) => {
    if (perf.count > 0) {
      perf.igEngagement = perf.count > 0 ? perf.igEngagement / perf.count : 0;
      perf.tiktokEngagement = perf.count > 0 ? perf.tiktokEngagement / perf.count : 0;
    }
  });

  // Generate base hashtags (only from current video's metadata)
  const baseHashtags = generateBaseHashtags(artistName, trackName, genres);

  // Get previous hashtag sets for variation calculation (with posted dates for temporal weighting)
  const previousHashtagSets = [];
  allVideos.forEach(video => {
    if (video.s3Key === currentVideo.s3Key) return;
    
    // Get posted date or use upload timestamp as fallback
    let postedDate = null;
    if (video.postedDate) {
      // Parse date string (could be YYYY-MM-DD or ISO format)
      if (/^\d{4}-\d{2}-\d{2}$/.test(video.postedDate)) {
        postedDate = new Date(video.postedDate + 'T12:00:00').getTime();
      } else {
        postedDate = new Date(video.postedDate).getTime();
      }
    } else if (video.uploadTimestamp) {
      postedDate = video.uploadTimestamp;
    }
    
    if (video.igHashtags) {
      const tags = extractHashtags(video.igHashtags).map(t => t.toLowerCase());
      if (tags.length > 0) {
        previousHashtagSets.push({ 
          tags: new Set(tags), 
          postedDate: postedDate 
        });
      }
    }
  });
  
  // Sort by posted date (most recent first) for better rotation tracking
  previousHashtagSets.sort((a, b) => {
    const dateA = a.postedDate || 0;
    const dateB = b.postedDate || 0;
    return dateB - dateA;
  });

  // Generate Instagram recommendations with improved algorithm
  const instagramSuggestions = generateInstagramSuggestions(
    baseHashtags,
    hashtagPerformance,
    otherArtistNames,
    genres,
    artistName,
    trackName,
    previousHashtagSets
  );

  // Get previous TikTok hashtag sets for variation calculation (with posted dates)
  const previousTikTokHashtagSets = [];
  allVideos.forEach(video => {
    if (video.s3Key === currentVideo.s3Key) return;
    
    // Get posted date or use upload timestamp as fallback
    let postedDate = null;
    if (video.postedDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(video.postedDate)) {
        postedDate = new Date(video.postedDate + 'T12:00:00').getTime();
      } else {
        postedDate = new Date(video.postedDate).getTime();
      }
    } else if (video.uploadTimestamp) {
      postedDate = video.uploadTimestamp;
    }
    
    if (video.tiktokHashtags) {
      const tags = extractHashtags(video.tiktokHashtags).map(t => t.toLowerCase());
      if (tags.length > 0) {
        previousTikTokHashtagSets.push({ 
          tags: new Set(tags), 
          postedDate: postedDate 
        });
      }
    }
  });
  
  // Sort by posted date (most recent first)
  previousTikTokHashtagSets.sort((a, b) => {
    const dateA = a.postedDate || 0;
    const dateB = b.postedDate || 0;
    return dateB - dateA;
  });

  // Generate TikTok recommendations with improved algorithm
  const videoType = currentVideo.videoType || null;
  const tiktokSuggestions = generateTikTokSuggestions(
    baseHashtags,
    hashtagPerformance,
    otherArtistNames,
    genres,
    artistName,
    trackName,
    videoType,
    previousTikTokHashtagSets
  );

  return {
    instagram: instagramSuggestions,
    tiktok: tiktokSuggestions
  };
}

function extractHashtags(text) {
  if (!text) return [];
  const hashtagRegex = /#[\w]+/g;
  const matches = text.match(hashtagRegex) || [];
  return matches.map(tag => tag.toLowerCase());
}

function calculateEngagement(views, likes) {
  if (!views || views === 0) return 0;
  if (!likes) return 0;
  // Engagement rate: likes per 1000 views
  return (likes / views) * 1000;
}

function generateBaseHashtags(artistName, trackName, genres) {
  const hashtags = [];

  // Always include band name
  if (artistName) {
    const bandTag = `#${normalizeForHashtag(artistName)}`;
    hashtags.push({ tag: bandTag, priority: 10, source: 'band' });
  }

  // Add track name (if not too long)
  if (trackName && trackName.length < 30) {
    const trackTag = `#${normalizeForHashtag(trackName)}`;
    hashtags.push({ tag: trackTag, priority: 8, source: 'track' });
  }

  // Add genre-based hashtags
  genres.forEach(genre => {
    const genreTag = `#${normalizeForHashtag(genre)}`;
    hashtags.push({ tag: genreTag, priority: 7, source: 'genre' });
  });

  // Add general drumming/music hashtags
  const generalTags = [
    '#drumming', '#drummer', '#drums', '#music', '#musician',
    '#drumcover', '#drumvideo', '#drumlife', '#drummerlife',
    '#musicproduction', '#livemusic', '#rockmusic', '#musiclover'
  ];

  generalTags.forEach(tag => {
    hashtags.push({ tag, priority: 5, source: 'general' });
  });

  return hashtags;
}

function normalizeForHashtag(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, '') // Remove spaces
    .substring(0, 30); // Limit length
}

// ----------------------
// Hashtag Volume Categories (Instagram post counts)
// ----------------------
// High-volume: >1M posts
// Medium-volume: 100k-1M posts
// Niche: <100k posts
const HASHTAG_VOLUMES = {
  // High-volume hashtags (>1M posts)
  high: new Set([
    'drumming', 'drummer', 'drums', 'music', 'musician', 'musicians',
    'drumcover', 'musicvideo', 'livemusic', 'rockmusic', 'musiclover',
    'instamusic', 'musicproducer', 'drumlife', 'drummerlife'
  ]),
  // Medium-volume hashtags (100k-1M posts)
  medium: new Set([
    'drumvideo', 'drumbeat', 'drummingvideo', 'drumtutorial',
    'drumcovers', 'drumminglife', 'drumset', 'drumkit', 'drumstudio',
    'musicproduction', 'musicianlife', 'cover', 'coversong', 'musiccovers',
    'rockmusic', 'metal', 'progressiverock', 'jazz', 'funkmusic'
  ]),
  // Niche hashtags (<100k posts)
  niche: new Set([
    'drumfill', 'drumfills', 'doublekick', 'blastbeat', 'drumgroove',
    'drummingtechnique', 'drumlessons', 'drumminglessons', 'drumteacher',
    'electronicdrums', 'acousticdrums', 'snaredrum', 'bassdrum',
    'cymbals', 'drumsticks', 'drummersofinstagram', 'drummerslife'
  ])
};

// Get volume category for a hashtag
function getHashtagVolume(tag) {
  const tagLower = tag.toLowerCase().replace('#', '');
  if (HASHTAG_VOLUMES.high.has(tagLower)) return 'high';
  if (HASHTAG_VOLUMES.medium.has(tagLower)) return 'medium';
  if (HASHTAG_VOLUMES.niche.has(tagLower)) return 'niche';
  // Default: assume medium if unknown (can be improved with API calls)
  return 'medium';
}

// Calculate Jaccard similarity between two sets
function jaccardSimilarity(set1, set2) {
  if (set1.size === 0 && set2.size === 0) return 1;
  if (set1.size === 0 || set2.size === 0) return 0;
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

// Genre to hashtag mapping (for Instagram and TikTok)
const GENRE_HASHTAGS = {
  'rock': ['rock', 'rockmusic', 'classicrock', 'hardrock', 'alternativerock', 'progrock'],
  'metal': ['metal', 'heavymetal', 'metalmusic', 'deathmetal', 'metalcove'],
  'jazz': ['jazz', 'jazzmusic', 'jazzdrums', 'bebop', 'smoothjazz'],
  'funk': ['funk', 'funkmusic', 'funkydrums', 'pfunk'],
  'pop': ['pop', 'popmusic', 'poppunk', 'indiepop'],
  'punk': ['punk', 'punkrock', 'punkdrums', 'hardcore'],
  'blues': ['blues', 'bluesmusic', 'bluesdrums'],
  'country': ['country', 'countrymusic', 'countrydrums'],
  'electronic': ['electronic', 'edm', 'electronicmusic', 'electronicdrums'],
  'hip hop': ['hiphop', 'rap', 'hiphopdrums', 'traphip'],
  'r&b': ['rnb', 'rb', 'randb', 'soul'],
  'reggae': ['reggae', 'reggaemusic', 'reggaedrums'],
  'progressive rock': ['progrock', 'progressiverock', 'prog'],
  'alternative': ['alternative', 'altrock', 'alternativerock'],
  'indie': ['indie', 'indierock', 'indiemusic']
};

// Normalize genre name for lookup
function normalizeGenre(genre) {
  return genre.toLowerCase().trim();
}

// Get genre hashtags for a list of genres
function getGenreHashtags(genres) {
  const genreTags = [];
  const usedGenres = new Set();
  
  for (const genre of genres) {
    const normalized = normalizeGenre(genre);
    if (usedGenres.has(normalized)) continue;
    usedGenres.add(normalized);
    
    // Direct match
    if (GENRE_HASHTAGS[normalized]) {
      genreTags.push(...GENRE_HASHTAGS[normalized]);
      continue;
    }
    
    // Partial match (e.g., "progressive rock" contains "rock")
    for (const [key, tags] of Object.entries(GENRE_HASHTAGS)) {
      if (normalized.includes(key) || key.includes(normalized)) {
        genreTags.push(...tags);
        break;
      }
    }
  }
  
  return [...new Set(genreTags)]; // Remove duplicates
}

// Check if a hashtag set has sufficient variation from previous posts (with temporal weighting)
// Recent posts are weighted more heavily in similarity checks
function hasSufficientVariation(proposedSet, previousSets, threshold = 0.7) {
  if (previousSets.length === 0) return true;
  
  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const oneMonth = 30 * 24 * 60 * 60 * 1000;
  
  for (const prevSetData of previousSets) {
    const prevSet = prevSetData.tags || prevSetData; // Support both old format and new format
    const similarity = jaccardSimilarity(proposedSet, prevSet);
    
    // Adjust threshold based on recency - more recent posts require more variation
    let effectiveThreshold = threshold;
    if (prevSetData.postedDate) {
      const daysSincePosted = (now - prevSetData.postedDate) / (24 * 60 * 60 * 1000);
      
      if (daysSincePosted < 7) {
        // Very recent (within a week) - require more variation
        effectiveThreshold = threshold * 0.6; // Stricter (0.7 * 0.6 = 0.42)
      } else if (daysSincePosted < 30) {
        // Recent (within a month) - moderate variation
        effectiveThreshold = threshold * 0.8; // Moderately stricter (0.7 * 0.8 = 0.56)
      }
      // Older posts use default threshold
    }
    
    if (similarity >= effectiveThreshold) {
      return false; // Too similar to a previous post
    }
  }
  return true; // Sufficient variation
}

// Generate Instagram hashtag suggestions with improved algorithm
function generateInstagramSuggestions(
  baseHashtags,
  hashtagPerformance,
  otherArtistNames,
  genres,
  artistName,
  trackName,
  previousHashtagSets
) {
  const suggestions = [];
  const usedTags = new Set();
  
  // Track volume categories
  let highCount = 0;
  let mediumCount = 0;
  let nicheCount = 0;
  let genreTagCount = 0;
  
  // Target counts: 1-2 high, 3-5 medium, 1-2 niche (total 15 always)
  const targetHigh = 2; // 1-2 high volume
  const targetMedium = 6; // 3-5 medium (aim for more to reach 15)
  const targetNiche = 3; // At least 1, aim for more
  const targetTotal = 15; // Always return 15 hashtags
  const minGenreTags = 1; // At least 1 genre tag required
  
  // Priority 1: Always include band name and song name cleanly
  const bandTag = baseHashtags.find(h => h.source === 'band');
  if (bandTag && artistName) {
    const cleanBandTag = `#${normalizeForHashtag(artistName)}`;
    suggestions.push(cleanBandTag);
    usedTags.add(cleanBandTag.toLowerCase());
    // Band tags are typically niche unless very popular
    nicheCount++;
  }
  
  const trackTag = baseHashtags.find(h => h.source === 'track');
  if (trackTag && trackName && trackName.length < 30) {
    const cleanTrackTag = `#${normalizeForHashtag(trackName)}`;
    if (!usedTags.has(cleanTrackTag.toLowerCase())) {
      suggestions.push(cleanTrackTag);
      usedTags.add(cleanTrackTag.toLowerCase());
      // Track tags are typically niche unless very popular
      nicheCount++;
    }
  }
  
  // Priority 2: Genre hashtags (REQUIRED - at least 1 for Instagram)
  const genreTagOptions = getGenreHashtags(genres);
  const genreTags = [];
  genreTagOptions.forEach(genreTag => {
    const tag = `#${genreTag}`;
    if (!usedTags.has(tag.toLowerCase())) {
      const volume = getHashtagVolume(tag);
      genreTags.push({ tag, volume, genreTag: true });
    }
  });
  
  // Priority 3: Drum-related hashtags (reduced dominance - balanced with genre)
  const drumTags = [
    { tag: '#drummer', volume: 'high' },
    { tag: '#drumming', volume: 'high' },
    { tag: '#drums', volume: 'high' },
    { tag: '#drumcover', volume: 'high' },
    { tag: '#drumvideo', volume: 'medium' },
    { tag: '#drumbeat', volume: 'medium' },
    { tag: '#drumminglife', volume: 'medium' },
    { tag: '#drummingvideo', volume: 'medium' },
    { tag: '#drumfills', volume: 'niche' },
    { tag: '#drumgroove', volume: 'niche' },
    { tag: '#drummingtechnique', volume: 'niche' }
  ];
  
  // Score all potential hashtags
  const scoredHashtags = [];
  
  // Score genre tags with high priority (especially for Instagram)
  genreTags.forEach(({ tag, volume }) => {
    if (usedTags.has(tag.toLowerCase())) return;
    
    const perf = hashtagPerformance.get(tag.toLowerCase().replace('#', ''));
    let score = 18; // High base score for genre tags
    
    // Extra boost if we don't have genre tags yet
    if (genreTagCount < minGenreTags) score += 15; // Strong boost to ensure at least 1
    
    // Boost based on volume category needs
    if (volume === 'high' && highCount < targetHigh) score += 5;
    if (volume === 'medium' && mediumCount < targetMedium) score += 5;
    if (volume === 'niche' && nicheCount < targetNiche) score += 10;
    
    if (perf) {
      const engagement = perf.igEngagement || 0;
      score += Math.min(engagement / 10, 3);
    }
    
    scoredHashtags.push({ tag, score, source: 'genre', volume, isGenreTag: true });
  });
  
  // Score drum tags with moderate priority (less dominant than before)
  drumTags.forEach(({ tag, volume }) => {
    if (usedTags.has(tag.toLowerCase())) return;
    
    const perf = hashtagPerformance.get(tag.toLowerCase().replace('#', ''));
    let score = 12; // Reduced from 20 - less dominant than genre tags
    
    // Boost based on volume category needs
    if (volume === 'high' && highCount < targetHigh) score += 5;
    if (volume === 'medium' && mediumCount < targetMedium) score += 5;
    if (volume === 'niche' && nicheCount < targetNiche) score += 8;
    
    if (perf) {
      const engagement = perf.igEngagement || 0;
      score += Math.min(engagement / 10, 3);
    }
    
    scoredHashtags.push({ tag, score, source: 'drum', volume });
  });
  
  // Score other base hashtags (genre-based, general music tags)
  baseHashtags.forEach(base => {
    if (usedTags.has(base.tag.toLowerCase())) return;
    
    // Skip if it's already a drum tag we processed
    if (drumTags.some(dt => dt.tag.toLowerCase() === base.tag.toLowerCase())) return;
    
    const volume = getHashtagVolume(base.tag);
    const perf = hashtagPerformance.get(base.tag.toLowerCase().replace('#', ''));
    let score = base.priority;
    
    // Boost based on volume category needs
    if (volume === 'high' && highCount < targetHigh) score += 3;
    if (volume === 'medium' && mediumCount < targetMedium) score += 3;
    if (volume === 'niche' && nicheCount < targetNiche) score += 5;
    
    if (perf) {
      const engagement = perf.igEngagement || 0;
      score += Math.min(engagement / 10, 2);
    }
    
    scoredHashtags.push({ tag: base.tag, score, source: base.source, volume });
  });
  
  // Add historical high-performing hashtags
  const generalMusicTags = [
    'drumming', 'drummer', 'drums', 'music', 'musician',
    'drumcover', 'drumvideo', 'drumlife', 'drummerlife',
    'musicproduction', 'livemusic', 'rockmusic', 'musiclover',
    'drumbeat', 'drummingvideo', 'drumtutorial',
    'musicvideo', 'cover', 'coversong'
  ];
  
  hashtagPerformance.forEach((perf, tag) => {
    if (usedTags.has(tag)) return;
    if (otherArtistNames.has(tag)) return;
    if (!generalMusicTags.includes(tag)) return;
    
    const tagWithHash = `#${tag.replace('#', '')}`;
    if (usedTags.has(tagWithHash.toLowerCase())) return;
    
    const volume = getHashtagVolume(tagWithHash);
    const engagement = perf.igEngagement || 0;
    
    if (engagement > 0 || perf.igViews > 0) {
      let score = 3;
      score += Math.min(engagement / 10, 3);
      
      // Boost based on volume category needs
      if (volume === 'high' && highCount < targetHigh) score += 2;
      if (volume === 'medium' && mediumCount < targetMedium) score += 2;
      if (volume === 'niche' && nicheCount < targetNiche) score += 4;
      
      scoredHashtags.push({ tag: tagWithHash, score, source: 'historical', volume });
    }
  });
  
  // Sort by score (highest first)
  scoredHashtags.sort((a, b) => b.score - a.score);
  
  // Select hashtags to meet volume requirements
  const candidates = scoredHashtags.filter(h => !usedTags.has(h.tag.toLowerCase()));
  
  // First, ensure we have at least one genre tag (REQUIRED for Instagram)
  if (genreTagCount < minGenreTags) {
    const genreCandidate = candidates.find(h => h.isGenreTag);
    if (genreCandidate) {
      suggestions.push(genreCandidate.tag);
      usedTags.add(genreCandidate.tag.toLowerCase());
      genreTagCount++;
      if (genreCandidate.volume === 'high') highCount++;
      else if (genreCandidate.volume === 'medium') mediumCount++;
      else if (genreCandidate.volume === 'niche') nicheCount++;
    }
  }
  
  // Second, ensure we have at least one niche hashtag (requirement: always at least one niche)
  if (nicheCount === 0) {
    const nicheCandidate = candidates.find(h => h.volume === 'niche');
    if (nicheCandidate) {
      suggestions.push(nicheCandidate.tag);
      usedTags.add(nicheCandidate.tag.toLowerCase());
      nicheCount++;
      if (nicheCandidate.isGenreTag) genreTagCount++;
    }
  }
  
  // Then, fill remaining slots prioritizing volume mix
  while (suggestions.length < targetTotal && candidates.length > 0) {
    let selected = null;
    let maxScore = -1;
    
    // Prioritize candidates that help meet volume targets
    for (const candidate of candidates) {
      if (usedTags.has(candidate.tag.toLowerCase())) continue;
      
      // Check if adding this candidate helps meet volume targets
      const wouldHigh = candidate.volume === 'high' ? highCount + 1 : highCount;
      const wouldMedium = candidate.volume === 'medium' ? mediumCount + 1 : mediumCount;
      const wouldNiche = candidate.volume === 'niche' ? nicheCount + 1 : nicheCount;
      
      // Prefer candidates that move us toward targets
      let score = candidate.score;
      if (candidate.volume === 'high' && wouldHigh < targetHigh) score += 10;
      if (candidate.volume === 'medium' && wouldMedium < targetMedium) score += 8;
      if (candidate.volume === 'niche' && wouldNiche < targetNiche) score += 12; // Prioritize niche
      
      // Avoid going too far over targets
      if (candidate.volume === 'high' && wouldHigh > targetHigh) score -= 5;
      if (candidate.volume === 'medium' && wouldMedium > targetMedium) score -= 3;
      
      if (score > maxScore) {
        maxScore = score;
        selected = candidate;
      }
    }
    
    if (!selected) break;
    
    // Check Jaccard similarity with previous posts before adding (using date-weighted variation)
    const testSet = new Set([...suggestions.map(t => t.toLowerCase()), selected.tag.toLowerCase()]);
    if (hasSufficientVariation(testSet, previousHashtagSets, 0.7)) {
      suggestions.push(selected.tag);
      usedTags.add(selected.tag.toLowerCase());
      
      if (selected.volume === 'high') highCount++;
      else if (selected.volume === 'medium') mediumCount++;
      else if (selected.volume === 'niche') nicheCount++;
      if (selected.isGenreTag) genreTagCount++;
    } else {
      // Skip this tag as it's too similar to previous posts (based on posted dates)
      usedTags.add(selected.tag.toLowerCase()); // Mark as used so we don't try again
    }
  }
  
  // If we still don't have enough, fill without volume restrictions (but still check variation)
  // Keep going until we reach targetTotal (15)
  while (suggestions.length < targetTotal && candidates.length > 0) {
    const remaining = candidates.find(h => !usedTags.has(h.tag.toLowerCase()));
    if (!remaining) break;
    
    const testSet = new Set([...suggestions.map(t => t.toLowerCase()), remaining.tag.toLowerCase()]);
    if (hasSufficientVariation(testSet, previousHashtagSets, 0.7)) {
      suggestions.push(remaining.tag);
      usedTags.add(remaining.tag.toLowerCase());
      
      // Update volume counters
      if (remaining.volume === 'high') highCount++;
      else if (remaining.volume === 'medium') mediumCount++;
      else if (remaining.volume === 'niche') nicheCount++;
      if (remaining.isGenreTag) genreTagCount++;
    } else {
      usedTags.add(remaining.tag.toLowerCase());
    }
  }
  
  // Final check: ensure we have at least one genre tag (critical requirement)
  if (genreTagCount === 0 && suggestions.length > 0) {
    const allGenreCandidates = scoredHashtags.filter(h => h.isGenreTag && !usedTags.has(h.tag.toLowerCase()));
    if (allGenreCandidates.length > 0) {
      // Replace a less critical hashtag with a genre one
      suggestions[suggestions.length - 1] = allGenreCandidates[0].tag;
      genreTagCount++;
    }
  }
  
  // Ensure we have at least one niche hashtag (critical requirement)
  if (nicheCount === 0 && suggestions.length > 0) {
    // Find any niche candidate from all available
    const allNiche = scoredHashtags.filter(h => h.volume === 'niche');
    if (allNiche.length > 0) {
      // Replace a less critical hashtag with a niche one
      suggestions[suggestions.length - 1] = allNiche[0].tag;
      nicheCount++;
    }
  }
  
  // Pad to exactly 15 if needed (use remaining candidates)
  while (suggestions.length < targetTotal && candidates.length > 0) {
    const remaining = candidates.find(h => !usedTags.has(h.tag.toLowerCase()));
    if (!remaining) break;
    
    // Skip variation check for final padding - prioritize filling to 15
    suggestions.push(remaining.tag);
    usedTags.add(remaining.tag.toLowerCase());
    
    if (remaining.volume === 'high') highCount++;
    else if (remaining.volume === 'medium') mediumCount++;
    else if (remaining.volume === 'niche') nicheCount++;
    if (remaining.isGenreTag) genreTagCount++;
  }
  
  // Always return exactly 15 hashtags (or fewer if not enough candidates available)
  return suggestions.slice(0, targetTotal);
}

// ----------------------
// TikTok Hashtag Categories
// ----------------------
// Broad discovery tags: High-volume tags that help with discovery
// Niche identify tags: Specific tags that identify the content type
// Generic tags: General tags like #music, #viral, etc. (max 1, exclude #fyp)
// Video type tags: Tags based on videoType metadata
const TIKTOK_BROAD_DISCOVERY = [
  'drumming', 'drummer', 'drums', 'music', 'musician', 'musicians',
  'musicvideo', 'livemusic', 'rockmusic', 'musiclover',
  'drumcover', 'drumvideo', 'musicproducer'
];

const TIKTOK_NICHE_IDENTIFY = [
  'drumbeat', 'drummingvideo', 'drumtutorial', 'drumfills',
  'drumgroove', 'drummingtechnique', 'drummersoftiktok',
  'drummerslife', 'doublekick', 'blastbeat', 'drumfill',
  'drumlessons', 'drumminglessons', 'drumstudio'
];

const TIKTOK_GENERIC = [
  'music', 'viral', 'trending', 'fyp' // Note: #fyp excluded
];

// Video type to hashtag mapping
const VIDEO_TYPE_TAGS = {
  'Solo Mix': ['drumsolo', 'solo', 'drumming', 'drumcover'],
  'Collab': ['collab', 'drumcollab', 'collaboration', 'livemusic'],
  'Live': ['livemusic', 'live', 'liveperformance', 'concert', 'drumminglive'],
  'Original': ['original', 'originalmusic', 'originalcontent', 'oc'],
  'Other': ['drumming', 'drumcover', 'music']
};

// Generate TikTok hashtag suggestions with improved algorithm
function generateTikTokSuggestions(
  baseHashtags,
  hashtagPerformance,
  otherArtistNames,
  genres,
  artistName,
  trackName,
  videoType,
  previousHashtagSets = []
) {
  const suggestions = [];
  const usedTags = new Set();
  
  // Track categories
  let broadDiscoveryCount = 0;
  let nicheIdentifyCount = 0;
  let genericCount = 0;
  
  // Target: Always 15 hashtags
  const targetTotal = 15; // Always return 15 hashtags
  const minBroad = 3; // At least 3 broad discovery (increased for 15 total)
  const minNiche = 3; // At least 3 niche identify (increased for 15 total)
  const maxGeneric = 1; // Max 1 generic tag
  
  // Priority 1: Song/band name tags (HIGH VALUE for TikTok)
  if (trackName && trackName.length < 30) {
    const trackNormalized = normalizeForHashtag(trackName);
    const trackTag = `#${trackNormalized}`;
    const trackCoverTag = `#${trackNormalized}cover`;
    
    suggestions.push(trackTag);
    usedTags.add(trackTag.toLowerCase());
    
    // Add cover variant if it fits
    if (trackCoverTag.length <= 31 && suggestions.length < targetTotal) {
      suggestions.push(trackCoverTag);
      usedTags.add(trackCoverTag.toLowerCase());
    }
  }
  
  if (artistName) {
    const bandNormalized = normalizeForHashtag(artistName);
    const bandTag = `#${bandNormalized}`;
    
    if (!usedTags.has(bandTag.toLowerCase())) {
      suggestions.push(bandTag);
      usedTags.add(bandTag.toLowerCase());
    }
  }
  
  // Priority 2: Video type tags (high value for calling out what the video is)
  if (videoType && VIDEO_TYPE_TAGS[videoType]) {
    const videoTypeTags = VIDEO_TYPE_TAGS[videoType];
    
    for (const tagName of videoTypeTags) {
      if (suggestions.length >= targetTotal) break;
      
      const tag = `#${tagName}`;
      if (!usedTags.has(tag.toLowerCase())) {
        // Check if it's broad discovery or niche
        const isBroad = TIKTOK_BROAD_DISCOVERY.includes(tagName);
        const isNiche = TIKTOK_NICHE_IDENTIFY.includes(tagName);
        
        // Prioritize video type tags that fulfill requirements
        if (isBroad && broadDiscoveryCount < minBroad) {
          suggestions.push(tag);
          usedTags.add(tag.toLowerCase());
          broadDiscoveryCount++;
        } else if (isNiche && nicheIdentifyCount < minNiche) {
          suggestions.push(tag);
          usedTags.add(tag.toLowerCase());
          nicheIdentifyCount++;
        } else if (!isBroad && !isNiche) {
          // It's a video type specific tag, add it
          suggestions.push(tag);
          usedTags.add(tag.toLowerCase());
        }
      }
    }
  }
  
  // Priority 3: Ensure we have broad discovery tags (with variation check)
  while (broadDiscoveryCount < minBroad && suggestions.length < targetTotal) {
    const broadTags = TIKTOK_BROAD_DISCOVERY.map(t => `#${t}`);
    let added = false;
    
    for (const tag of broadTags) {
      if (suggestions.length >= targetTotal) break;
      if (usedTags.has(tag.toLowerCase())) continue;
      if (otherArtistNames.has(tag.toLowerCase().replace('#', ''))) continue;
      
      // Check variation before adding
      const testSet = new Set([...suggestions.map(t => t.toLowerCase()), tag.toLowerCase()]);
      if (hasSufficientVariation(testSet, previousHashtagSets, 0.7)) {
        suggestions.push(tag);
        usedTags.add(tag.toLowerCase());
        broadDiscoveryCount++;
        added = true;
        break;
      }
    }
    if (!added) break; // No more valid broad tags with sufficient variation
  }
  
  // Priority 4: Ensure we have niche identify tags (with variation check)
  while (nicheIdentifyCount < minNiche && suggestions.length < targetTotal) {
    const nicheTags = TIKTOK_NICHE_IDENTIFY.map(t => `#${t}`);
    let added = false;
    
    for (const tag of nicheTags) {
      if (suggestions.length >= targetTotal) break;
      if (usedTags.has(tag.toLowerCase())) continue;
      if (otherArtistNames.has(tag.toLowerCase().replace('#', ''))) continue;
      
      // Check variation before adding
      const testSet = new Set([...suggestions.map(t => t.toLowerCase()), tag.toLowerCase()]);
      if (hasSufficientVariation(testSet, previousHashtagSets, 0.7)) {
        suggestions.push(tag);
        usedTags.add(tag.toLowerCase());
        nicheIdentifyCount++;
        added = true;
        break;
      }
    }
    if (!added) break; // No more valid niche tags with sufficient variation
  }
  
  // Priority 5: Add video type specific tags that are high value
  // (e.g., #drumcover, #drumsolo, #livemusic)
  const highValueVideoTags = [
    { tag: '#drumcover', category: 'broad' },
    { tag: '#drumsolo', category: 'niche' },
    { tag: '#livemusic', category: 'broad' },
    { tag: '#drumvideo', category: 'broad' },
    { tag: '#drumbeat', category: 'niche' }
  ];
  
  for (const { tag, category } of highValueVideoTags) {
    if (suggestions.length >= targetTotal) break;
    if (usedTags.has(tag.toLowerCase())) continue;
    
    const tagLower = tag.toLowerCase().replace('#', '');
    if (otherArtistNames.has(tagLower)) continue;
    
    // Check if this helps fulfill requirements
    if (category === 'broad' && broadDiscoveryCount < 2) {
      suggestions.push(tag);
      usedTags.add(tag.toLowerCase());
      broadDiscoveryCount++;
    } else if (category === 'niche' && nicheIdentifyCount < 2) {
      suggestions.push(tag);
      usedTags.add(tag.toLowerCase());
      nicheIdentifyCount++;
    } else if (suggestions.length < targetTotal) {
      // Add it anyway if we have room
      suggestions.push(tag);
      usedTags.add(tag.toLowerCase());
    }
  }
  
  // Priority 6: Add one generic tag if needed (max 1, exclude #fyp)
  if (genericCount < maxGeneric && suggestions.length < targetTotal) {
    const genericTags = TIKTOK_GENERIC.filter(t => t !== 'fyp') // Exclude #fyp
      .map(t => `#${t}`);
    
    for (const tag of genericTags) {
      if (suggestions.length >= targetTotal) break;
      if (usedTags.has(tag.toLowerCase())) continue;
      
      const tagLower = tag.toLowerCase().replace('#', '');
      if (otherArtistNames.has(tagLower)) continue;
      
      suggestions.push(tag);
      usedTags.add(tag.toLowerCase());
      genericCount++;
      break;
    }
  }
  
  // Priority 7: Fill remaining slots with high-performing historical tags
  const historicalCandidates = [];
  
  hashtagPerformance.forEach((perf, tag) => {
    if (usedTags.has(tag)) return;
    if (otherArtistNames.has(tag)) return;
    
    const tagWithHash = `#${tag.replace('#', '')}`;
    if (usedTags.has(tagWithHash.toLowerCase())) return;
    
    const isBroad = TIKTOK_BROAD_DISCOVERY.includes(tag);
    const isNiche = TIKTOK_NICHE_IDENTIFY.includes(tag);
    const isGeneric = TIKTOK_GENERIC.includes(tag);
    
    // Skip generic tags if we already have one
    if (isGeneric && genericCount >= maxGeneric) return;
    // Skip #fyp always
    if (tag === 'fyp') return;
    
    const engagement = perf.tiktokEngagement || 0;
    const views = perf.tiktokViews || 0;
    
    if (engagement > 0 || views > 0) {
      let score = 2;
      score += Math.min(engagement / 10, 3);
      score += Math.min(Math.log10(views + 1) / 2, 2);
      
      // Boost based on what we need
      if (isBroad && broadDiscoveryCount < 2) score += 5;
      if (isNiche && nicheIdentifyCount < 2) score += 5;
      
      historicalCandidates.push({ 
        tag: tagWithHash, 
        score, 
        isBroad, 
        isNiche, 
        isGeneric 
      });
    }
  });
  
  // Sort by score and add remaining tags
  historicalCandidates.sort((a, b) => b.score - a.score);
  
  for (const candidate of historicalCandidates) {
    if (suggestions.length >= targetTotal) break;
    
    // Check limits
    if (candidate.isGeneric && genericCount >= maxGeneric) continue;
    
    // Check variation before adding
    const testSet = new Set([...suggestions.map(t => t.toLowerCase()), candidate.tag.toLowerCase()]);
    if (hasSufficientVariation(testSet, previousHashtagSets, 0.7)) {
      suggestions.push(candidate.tag);
      usedTags.add(candidate.tag.toLowerCase());
      
      if (candidate.isBroad) broadDiscoveryCount++;
      if (candidate.isNiche) nicheIdentifyCount++;
      if (candidate.isGeneric) genericCount++;
    }
  }
  
  // Final validation: Ensure we have at least minBroad and minNiche (CRITICAL REQUIREMENTS)
  // This is done even if we exceed targetTotal to ensure requirements are met
  while (broadDiscoveryCount < minBroad && suggestions.length < targetTotal * 1.2) {
    const broadTag = TIKTOK_BROAD_DISCOVERY.find(t => 
      !usedTags.has(`#${t}`.toLowerCase()) && 
      !otherArtistNames.has(t)
    );
    if (broadTag) {
      const tag = `#${broadTag}`;
      const testSet = new Set([...suggestions.map(t => t.toLowerCase()), tag.toLowerCase()]);
      if (hasSufficientVariation(testSet, previousHashtagSets, 0.7)) {
        suggestions.push(tag);
        usedTags.add(tag.toLowerCase());
        broadDiscoveryCount++;
      } else {
        usedTags.add(tag.toLowerCase()); // Mark as used to skip
      }
    } else {
      break;
    }
  }
  
  while (nicheIdentifyCount < minNiche && suggestions.length < targetTotal * 1.2) {
    const nicheTag = TIKTOK_NICHE_IDENTIFY.find(t => 
      !usedTags.has(`#${t}`.toLowerCase()) && 
      !otherArtistNames.has(t)
    );
    if (nicheTag) {
      const tag = `#${nicheTag}`;
      const testSet = new Set([...suggestions.map(t => t.toLowerCase()), tag.toLowerCase()]);
      if (hasSufficientVariation(testSet, previousHashtagSets, 0.7)) {
        suggestions.push(tag);
        usedTags.add(tag.toLowerCase());
        nicheIdentifyCount++;
      } else {
        usedTags.add(tag.toLowerCase()); // Mark as used to skip
      }
    } else {
      break;
    }
  }
  
  // Pad to exactly 15 if needed (use remaining candidates without strict variation check)
  while (suggestions.length < targetTotal) {
    // Use any remaining candidates from all sources
    const allRemaining = [
      ...historicalCandidates.filter(h => !usedTags.has(h.tag.toLowerCase())),
      ...highValueVideoTags.filter(h => !usedTags.has(h.tag.toLowerCase())).map(h => ({ 
        tag: h.tag, 
        score: 10, 
        isBroad: h.category === 'broad', 
        isNiche: h.category === 'niche',
        isGeneric: false
      })),
      ...TIKTOK_BROAD_DISCOVERY.filter(t => !usedTags.has(`#${t}`.toLowerCase())).map(t => ({ 
        tag: `#${t}`, 
        score: 5, 
        isBroad: true, 
        isNiche: false,
        isGeneric: false
      })),
      ...TIKTOK_NICHE_IDENTIFY.filter(t => !usedTags.has(`#${t}`.toLowerCase())).map(t => ({ 
        tag: `#${t}`, 
        score: 5, 
        isBroad: false, 
        isNiche: true,
        isGeneric: false
      }))
    ];
    
    const remaining = allRemaining[0]; // Take first available
    if (!remaining) break;
    
    // Skip variation check for final padding - prioritize filling to 15
    suggestions.push(remaining.tag);
    usedTags.add(remaining.tag.toLowerCase());
    
    if (remaining.isBroad) broadDiscoveryCount++;
    if (remaining.isNiche) nicheIdentifyCount++;
    if (remaining.isGeneric) genericCount++;
  }
  
  // Always return exactly 15 hashtags (or fewer if not enough candidates available)
  return suggestions.slice(0, targetTotal);
}

function generatePlatformSuggestions(baseHashtags, hashtagPerformance, otherArtistNames, spotifyGenres, platform, maxCount) {
  const suggestions = [];
  const usedTags = new Set();

  // Create a set of normalized Spotify genre hashtags for validation
  const spotifyGenreTags = new Set();
  spotifyGenres.forEach(genre => {
    spotifyGenreTags.add(normalizeForHashtag(genre).toLowerCase());
  });

  // Always include band name first
  const bandTag = baseHashtags.find(h => h.source === 'band');
  if (bandTag) {
    suggestions.push(bandTag.tag);
    usedTags.add(bandTag.tag.toLowerCase());
  }

  // Score all potential hashtags
  const scoredHashtags = [];

  // Score base hashtags (band, track, genres from Spotify, general tags)
  baseHashtags.forEach(base => {
    if (usedTags.has(base.tag.toLowerCase())) return;
    
    const perf = hashtagPerformance.get(base.tag.toLowerCase());
    let score = base.priority;

    if (perf) {
      // Boost score based on historical performance (validation)
      const engagement = platform === 'instagram' ? perf.igEngagement : perf.tiktokEngagement;
      const views = platform === 'instagram' ? perf.igViews : perf.tiktokViews;
      
      // Add performance boost (normalized)
      score += Math.min(engagement / 10, 3); // Max 3 point boost from engagement
      score += Math.min(Math.log10(views + 1) / 2, 2); // Max 2 point boost from views
      score += Math.min(perf.count / 5, 1); // Max 1 point boost from usage frequency
    }

    scoredHashtags.push({ tag: base.tag, score, source: base.source });
  });

  // Only add historical hashtags that are:
  // 1. General music/drumming tags (not genre-specific or artist-specific)
  // 2. Not matching other artist names
  // 3. Not already in base hashtags
  // Historical data is used for validation/scoring, not for adding new genres or artist names
  const generalMusicTags = [
    'drumming', 'drummer', 'drums', 'music', 'musician',
    'drumcover', 'drumvideo', 'drumlife', 'drummerlife',
    'musicproduction', 'livemusic', 'rockmusic', 'musiclover',
    'drumbeat', 'drummingvideo', 'drumtutorial',
    'musicvideo', 'cover', 'coversong', 'drumcover'
  ];

  hashtagPerformance.forEach((perf, tag) => {
    if (usedTags.has(tag)) return;
    
    // Exclude if it matches another artist name
    if (otherArtistNames.has(tag)) return;
    
    // Only include general music tags, not genre-specific or artist-specific tags
    if (!generalMusicTags.includes(tag)) return;
    
    const engagement = platform === 'instagram' ? perf.igEngagement : perf.tiktokEngagement;
    const views = platform === 'instagram' ? perf.igViews : perf.tiktokViews;
    
    if (engagement > 0 || views > 0) {
      let score = 3; // Base score for historical general tags
      score += Math.min(engagement / 10, 3);
      score += Math.min(Math.log10(views + 1) / 2, 2);
      score += Math.min(perf.count / 5, 1);
      
      scoredHashtags.push({ tag: `#${tag.replace('#', '')}`, score, source: 'historical' });
    }
  });

  // Sort by score (highest first)
  scoredHashtags.sort((a, b) => b.score - a.score);

  // Add top suggestions, mixing them up
  const remaining = scoredHashtags.filter(h => !usedTags.has(h.tag.toLowerCase()));
  
  // Mix: take some high priority, some medium, some lower
  const highPriority = remaining.filter(h => h.score >= 7).slice(0, 5);
  const mediumPriority = remaining.filter(h => h.score >= 5 && h.score < 7).slice(0, 5);
  const lowPriority = remaining.filter(h => h.score < 5).slice(0, 5);

  // Interleave them for variety
  const mixed = [];
  const maxLen = Math.max(highPriority.length, mediumPriority.length, lowPriority.length);
  
  for (let i = 0; i < maxLen && mixed.length < maxCount - 1; i++) {
    if (i < highPriority.length && !usedTags.has(highPriority[i].tag.toLowerCase())) {
      mixed.push(highPriority[i].tag);
      usedTags.add(highPriority[i].tag.toLowerCase());
    }
    if (mixed.length >= maxCount - 1) break;
    
    if (i < mediumPriority.length && !usedTags.has(mediumPriority[i].tag.toLowerCase())) {
      mixed.push(mediumPriority[i].tag);
      usedTags.add(mediumPriority[i].tag.toLowerCase());
    }
    if (mixed.length >= maxCount - 1) break;
    
    if (i < lowPriority.length && !usedTags.has(lowPriority[i].tag.toLowerCase())) {
      mixed.push(lowPriority[i].tag);
      usedTags.add(lowPriority[i].tag.toLowerCase());
    }
  }

  suggestions.push(...mixed);

  // Ensure we have at least maxCount hashtags
  while (suggestions.length < maxCount && remaining.length > 0) {
    const next = remaining.find(h => !usedTags.has(h.tag.toLowerCase()));
    if (!next) break;
    suggestions.push(next.tag);
    usedTags.add(next.tag.toLowerCase());
  }

  return suggestions.slice(0, maxCount);
}

// ----------------------
// Delete Video Endpoint
// ----------------------
app.delete("/api/videos/:s3Key", async (req, res) => {
  try {
    const { s3Key } = req.params;
    
    if (!s3Key) {
      return res.status(400).json({ error: "Video key is required" });
    }

    if (!process.env.S3_BUCKET_NAME) {
      console.error("S3_BUCKET_NAME environment variable not set");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Delete the video file
    const deleteVideoCommand = new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key,
    });

    // Delete the JSON metadata file
    const deleteMetadataCommand = new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `results/${s3Key}.json`,
    });

    // Delete the snapshot image file
    const deleteSnapshotCommand = new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `snapshots/${s3Key}.jpg`,
    });

    // Delete all files in parallel
    await Promise.all([
      s3.send(deleteVideoCommand),
      s3.send(deleteMetadataCommand),
      s3.send(deleteSnapshotCommand).catch(err => {
        // Snapshot might not exist for older videos, so don't fail if it's missing
        console.log(`Snapshot not found for ${s3Key}, skipping deletion`);
      })
    ]);

    console.log(`Deleted video and metadata for: ${s3Key}`);
    
    res.json({ message: "Video and metadata deleted successfully", s3Key });
  } catch (err) {
    console.error("Error deleting video:", err);
    res.status(500).json({ error: "Failed to delete video", message: err.message });
  }
});

// ----------------------
// Upload Page Route
// ----------------------
app.get("/drumanalytics", (req, res) => {
  res.sendFile(path.join(publicDir, "upload.html"));
});

// ----------------------
// Start Server
// ----------------------
const PORT = 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`SERVER2 running at http://0.0.0.0:${PORT}`);
});