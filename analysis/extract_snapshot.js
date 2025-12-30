import { exec } from "child_process";
import fs from "fs";
import path from "path";

/**
 * Extracts a snapshot frame from a video file
 * @param {string} videoPath - Path to the video file
 * @param {string} outputPath - Path where the snapshot image should be saved
 * @param {number} timestamp - Time in seconds to extract frame from (default: 1 second or 10% of duration)
 * @returns {Promise<string>} - Path to the extracted snapshot image
 */
export function extractVideoSnapshot(videoPath, outputPath, timestamp = null) {
  return new Promise(async (resolve, reject) => {
    const TIMEOUT_MS = 30000; // 30 second timeout

    try {
      // If no timestamp provided, extract at 1 second or 10% of duration (whichever is smaller)
      let extractTime = timestamp;
      
      if (!extractTime) {
        // Get video duration first
        const durationCmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
        
        const duration = await new Promise((durResolve, durReject) => {
          exec(durationCmd, { timeout: 10000 }, (error, stdout) => {
            if (error) {
              durReject(error);
              return;
            }
            const dur = parseFloat(stdout.trim());
            durResolve(isNaN(dur) || dur <= 0 ? 1 : Math.min(1, dur * 0.1));
          });
        });
        
        extractTime = duration;
      }

      // Extract frame using ffmpeg
      // -ss: seek to timestamp
      // -vframes 1: extract only 1 frame
      // -q:v 2: high quality JPEG (scale 2-31, lower is better, 2 is very high quality)
      const cmd = `ffmpeg -ss ${extractTime} -i "${videoPath}" -vframes 1 -q:v 2 -y "${outputPath}"`;

      exec(cmd, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to extract snapshot: ${error.message}. ${stderr || ''}`));
          return;
        }

        if (!fs.existsSync(outputPath)) {
          reject(new Error("Snapshot file was not created"));
          return;
        }

        resolve(outputPath);
      });
    } catch (err) {
      reject(err);
    }
  });
}


