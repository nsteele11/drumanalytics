import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import fs from "fs";
import { analyzeVideo } from "../analysis/analyze_video.js"; // adjust path if needed

dotenv.config();

// ES module helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Temp upload folder
const uploadDir = path.join(__dirname, "uploads", "tmp");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'))); // serve static files (CSS, JS, HTML if needed)

// AWS S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// Download file from S3
async function downloadFromS3(key, localPath) {
  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key
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

// Multer setup (disk storage)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

// Upload endpoint → S3 + analysis + save results JSON
app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    const s3Key = `${Date.now()}-${req.file.originalname}`;
    const filePath = req.file.path;

    // Read file content from disk for S3
    const fileContent = fs.readFileSync(filePath);

    // Upload video to S3
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key,
      Body: fileContent,
      ContentType: req.file.mimetype
    }));
    console.log("Uploaded video to S3:", s3Key);

    // Download SAME file from S3 to temp path for analysis
    const tempPath = path.join(uploadDir, `temp-${s3Key}`);
    await downloadFromS3(s3Key, tempPath);
    console.log("Downloaded for analysis:", tempPath);

    // Analyze video
    const analysis = await analyzeVideo(tempPath);
    console.log("Analysis result:", analysis);

    // Create structured result object
    const resultObj = {
      s3_key: s3Key,
      original_filename: req.file.originalname,
      upload_timestamp: Date.now(),
      analysis
    };

    // Save locally
    const resultsDir = path.join(__dirname, "uploads", "results");
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });
    const localJsonPath = path.join(resultsDir, `${s3Key}.json`);
    fs.writeFileSync(localJsonPath, JSON.stringify(resultObj, null, 2));

// ===== SAVE ANALYSIS JSON TO S3 =====
const analysisKey = `results/${s3Key}.json`;

await s3.send(new PutObjectCommand({
  Bucket: process.env.S3_BUCKET_NAME,
  Key: analysisKey,
  Body: JSON.stringify(
    {
      video_key: s3Key,
      analyzed_at: new Date().toISOString(),
      analysis
    },
    null,
        2
  ),
  ContentType: "application/json"
}));

console.log("Analysis saved to S3:", analysisKey);

    // Cleanup temp files
    fs.unlinkSync(tempPath);
    fs.unlinkSync(filePath);

    // Respond to browser
    res.json({ status: "Upload + analysis + JSON saved successfully", analysis });

  } catch (err) {
    console.error("Upload or analysis error:", err);
    res.status(500).send("Upload or analysis failed");
  }
});

// DrumAnalytics upload page route
app.get("/drumanalytics", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "upload.html"));
});

const PORT = 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});