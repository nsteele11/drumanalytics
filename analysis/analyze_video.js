import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { detectAudioFeatures } from "./detect_bpm.js";

export async function analyzeVideo(localPath) {
  // Check if file exists
  if (!fs.existsSync(localPath)) {
    throw new Error(`Video file not found: ${localPath}`);
  }

  const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${localPath}"`;
  const TIMEOUT_MS = 60000; // 60 second timeout

  // First, get basic video info using ffprobe
  const basicAnalysis = await new Promise((resolve, reject) => {

    const childProcess = exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`FFprobe error: ${error.message}. ${stderr || ''}`));
        return;
      }

      if (!stdout || stdout.trim().length === 0) {
        reject(new Error("FFprobe returned empty output"));
        return;
      }

      try {
        const data = JSON.parse(stdout);

        if (!data.format || !data.streams) {
          reject(new Error("Invalid FFprobe output format"));
          return;
        }

        const videoStream = data.streams.find(s => s.codec_type === "video");
        const audioStream = data.streams.find(s => s.codec_type === "audio");

        // Calculate FPS safely without eval
        let fps = null;
        if (videoStream && videoStream.r_frame_rate) {
          const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
          if (den && den > 0) {
            fps = num / den;
          }
        }

        resolve({
          duration: Number(data.format.duration) || 0,
          size_mb: Number(data.format.size) / 1024 / 1024 || 0,
          video: videoStream
            ? {
                codec: videoStream.codec_name,
                width: videoStream.width,
                height: videoStream.height,
                fps: fps
              }
            : null,
          audio: audioStream
            ? {
                codec: audioStream.codec_name,
                sample_rate: audioStream.sample_rate,
                channels: audioStream.channels
              }
            : null,
          hasAudio: !!audioStream
        });
      } catch (parseError) {
        reject(new Error(`Failed to parse FFprobe output: ${parseError.message}`));
      }
    });

    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      childProcess.kill();
      reject(new Error("Video analysis timed out after 60 seconds"));
    }, TIMEOUT_MS);

    childProcess.on('exit', () => {
      clearTimeout(timeout);
    });
  });

  // Detect audio features if audio stream exists
  let audioFeatures = null;
  if (basicAnalysis.hasAudio) {
    try {
      const tempDir = path.dirname(localPath);
      audioFeatures = await detectAudioFeatures(localPath, tempDir);
      console.log(`Detected audio features:`, audioFeatures);
    } catch (audioError) {
      console.warn("Audio feature detection failed:", audioError.message);
      // Continue without audio features - don't fail the entire analysis
    }
  }

  // Remove hasAudio from result (it was just for internal use)
  delete basicAnalysis.hasAudio;

  return {
    ...basicAnalysis,
    ...(audioFeatures || {}), // Spread audio features into the result
    // Keep bpm at top level for backwards compatibility
    bpm: audioFeatures?.bpm || null
  };
}