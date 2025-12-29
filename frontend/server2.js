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
          analyzedAt: metadata.analyzedAt || null,
          uploadTimestamp: metadata.s3Key ? parseInt(metadata.s3Key.split('-')[0]) : null,
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

    // Delete both files in parallel
    await Promise.all([
      s3.send(deleteVideoCommand),
      s3.send(deleteMetadataCommand)
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