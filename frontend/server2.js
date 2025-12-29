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
    const videos = [];
    
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
          // Social media metrics
          igHashtags: metadata.igHashtags || null,
          tiktokHashtags: metadata.tiktokHashtags || null,
          igViews: metadata.igViews || null,
          igLikes: metadata.igLikes || null,
          tiktokViews: metadata.tiktokViews || null,
          tiktokLikes: metadata.tiktokLikes || null,
          metricsUpdatedAt: metadata.metricsUpdatedAt || null,
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

        videos.push(videoInfo);
      } catch (err) {
        console.error(`Error processing metadata for ${obj.Key}:`, err);
        // Continue with next video
      }
    }

    // Sort by upload timestamp (newest first)
    videos.sort((a, b) => (b.uploadTimestamp || 0) - (a.uploadTimestamp || 0));

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
    const { igHashtags, tiktokHashtags, igViews, igLikes, tiktokViews, tiktokLikes } = req.body;
    
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

    // Update the metrics
    metadata.igHashtags = igHashtags || null;
    metadata.tiktokHashtags = tiktokHashtags || null;
    metadata.igViews = igViews !== undefined && igViews !== null ? Number(igViews) : null;
    metadata.igLikes = igLikes !== undefined && igLikes !== null ? Number(igLikes) : null;
    metadata.tiktokViews = tiktokViews !== undefined && tiktokViews !== null ? Number(tiktokViews) : null;
    metadata.tiktokLikes = tiktokLikes !== undefined && tiktokLikes !== null ? Number(tiktokLikes) : null;
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
        metricsUpdatedAt: metadata.metricsUpdatedAt
      }
    });
  } catch (err) {
    console.error("Error updating video metrics:", err);
    res.status(500).json({ error: "Failed to update metrics", message: err.message });
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

  // Generate Instagram recommendations
  const instagramSuggestions = generatePlatformSuggestions(
    baseHashtags,
    hashtagPerformance,
    otherArtistNames,
    genres,
    'instagram',
    15
  );

  // Generate TikTok recommendations
  const tiktokSuggestions = generatePlatformSuggestions(
    baseHashtags,
    hashtagPerformance,
    otherArtistNames,
    genres,
    'tiktok',
    15
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