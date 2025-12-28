import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import dotenv from "dotenv";
import fs from "fs";
import { analyzeVideo } from "../analysis/analyze_video.js";

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
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

// ----------------------
// Upload + Analysis Endpoint
// ----------------------
app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    console.log("Uploaded file:", req.file);

    const s3Key = `${Date.now()}-${req.file.originalname}`;
    const filePath = req.file.path;

    // --- Upload video to S3 ---
    const fileContent = fs.readFileSync(filePath);
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: s3Key,
        Body: fileContent,
        ContentType: req.file.mimetype,
      })
    );
    console.log("Uploaded video to S3:", s3Key);

    // --- Download for analysis ---
    const tempPath = path.join(uploadDir, `temp-${s3Key}`);
    await downloadFromS3(s3Key, tempPath);
    console.log("Downloaded for analysis:", tempPath);

    const analysis = await analyzeVideo(tempPath);
    console.log("Analysis result:", analysis);

    // --- Save JSON locally ---
    const resultsDir = path.join(uploadDir, "results");
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    const localJsonPath = path.join(resultsDir, `${s3Key}.json`);
    fs.writeFileSync(
      localJsonPath,
      JSON.stringify({ s3Key, originalFilename: req.file.originalname, analysis }, null, 2)
    );

    // --- Upload JSON to S3 ---
    const analysisKey = `results/${s3Key}.json`;
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: analysisKey,
        Body: JSON.stringify({ videoKey: s3Key, analyzedAt: new Date().toISOString(), analysis }, null, 2),
        ContentType: "application/json",
      })
    );
    console.log("Analysis saved to S3:", analysisKey);

    // --- Cleanup ---
    fs.unlinkSync(tempPath);
    fs.unlinkSync(filePath);

    res.json({ message: "Upload complete; Analytics saved to file" });
  } catch (err) {
    console.error("Upload or analysis error:", err);
    res.status(500).send("Upload or analysis failed");
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