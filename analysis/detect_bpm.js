import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Extracts audio features from a video file using aubio
 * @param {string} videoPath - Path to the video file
 * @param {string} tempDir - Directory for temporary files
 * @returns {Promise<object>} - Object containing audio features (bpm, pitch, onsets, energy, etc.)
 */
export async function detectAudioFeatures(videoPath, tempDir) {
  return new Promise(async (resolve, reject) => {
    const TIMEOUT_MS = 120000; // 2 minute timeout for BPM detection
    
    try {
      // Step 1: Extract audio from video using ffmpeg
      const audioPath = path.join(tempDir, `audio_${Date.now()}.wav`);
      
      // Extract audio to WAV format (mono, 44100 Hz for better BPM detection)
      const extractCmd = `ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le -ar 44100 -ac 1 -y "${audioPath}"`;
      
      await new Promise((extractResolve, extractReject) => {
        exec(extractCmd, { timeout: 60000 }, (error, stdout, stderr) => {
          if (error) {
            // Clean up on error
            if (fs.existsSync(audioPath)) {
              try { fs.unlinkSync(audioPath); } catch (e) {}
            }
            extractReject(new Error(`Failed to extract audio: ${error.message}`));
            return;
          }
          extractResolve();
        });
      });

      if (!fs.existsSync(audioPath)) {
        return resolve(null);
      }

      // Step 2: Extract all audio features using aubio
      const features = {
        bpm: null,
        pitch: null,
        pitchConfidence: null,
        onsets: null,
        onsetRate: null,
        energy: null,
        silenceRatio: null
      };

      try {
        // Detect BPM/Tempo
        try {
          features.bpm = await detectBPMWithAubio(audioPath);
        } catch (bpmError) {
          console.log("BPM detection failed:", bpmError.message);
        }

        // Detect Pitch (fundamental frequency)
        try {
          const pitchData = await detectPitchWithAubio(audioPath);
          features.pitch = pitchData.pitch;
          features.pitchConfidence = pitchData.confidence;
        } catch (pitchError) {
          console.log("Pitch detection failed:", pitchError.message);
        }

        // Detect Onsets (beat/note starts)
        try {
          const onsetData = await detectOnsetsWithAubio(audioPath);
          features.onsets = onsetData.count;
          features.onsetRate = onsetData.rate;
        } catch (onsetError) {
          console.log("Onset detection failed:", onsetError.message);
        }

        // Detect Energy/Volume levels
        try {
          features.energy = await detectEnergyWithAubio(audioPath);
        } catch (energyError) {
          console.log("Energy detection failed:", energyError.message);
        }

        // Detect Silence ratio
        try {
          features.silenceRatio = await detectSilenceWithAubio(audioPath);
        } catch (silenceError) {
          console.log("Silence detection failed:", silenceError.message);
        }

      } catch (aubioError) {
        console.log("Aubio analysis failed:", aubioError.message);
      }

      // Clean up extracted audio file
      try {
        if (fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
      } catch (cleanupError) {
        console.warn("Failed to cleanup audio file:", cleanupError);
      }

      resolve(features);
    } catch (error) {
      reject(error);
    }
  });
}

// Legacy function name for backwards compatibility
export function detectBPM(videoPath, tempDir) {
  return detectAudioFeatures(videoPath, tempDir).then(features => features.bpm);
}

/**
 * Detect BPM using aubio command line tool
 */
function detectBPMWithAubio(audioPath) {
  return new Promise((resolve, reject) => {
    // aubio tempo command - analyzes audio and outputs BPM
    const cmd = `aubio tempo "${audioPath}"`;
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Aubio not available or failed: ${error.message}`));
        return;
      }

      // Parse output - aubio tempo outputs the detected BPM
      const lines = stdout.trim().split('\n');
      const bpmLine = lines.find(line => line.trim() && !line.startsWith('#'));
      
      if (bpmLine) {
        const bpm = parseFloat(bpmLine.trim());
        if (!isNaN(bpm) && bpm > 0 && bpm < 300) {
          resolve(Math.round(bpm * 10) / 10); // Round to 1 decimal place
        } else {
          reject(new Error("Invalid BPM value from aubio"));
        }
      } else {
        reject(new Error("No BPM found in aubio output"));
      }
    });
  });
}

/**
 * Detect Pitch using aubio pitch command
 * Returns average pitch in Hz and confidence
 */
function detectPitchWithAubio(audioPath) {
  return new Promise((resolve, reject) => {
    const cmd = `aubiopitch "${audioPath}"`;
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Pitch detection failed: ${error.message}`));
        return;
      }

      // Parse output - aubiopitch outputs pitch values per frame
      const lines = stdout.trim().split('\n').filter(line => line.trim() && !line.startsWith('#'));
      
      if (lines.length === 0) {
        reject(new Error("No pitch data found"));
        return;
      }

      // Extract pitch values (first column) and confidence (if available)
      const pitches = [];
      let totalConfidence = 0;
      let confidenceCount = 0;

      lines.forEach(line => {
        const parts = line.trim().split(/\s+/);
        const pitch = parseFloat(parts[0]);
        if (!isNaN(pitch) && pitch > 0 && pitch < 5000) { // Valid pitch range
          pitches.push(pitch);
          
          // Check for confidence value (if present)
          if (parts.length > 1) {
            const conf = parseFloat(parts[1]);
            if (!isNaN(conf)) {
              totalConfidence += conf;
              confidenceCount++;
            }
          }
        }
      });

      if (pitches.length === 0) {
        reject(new Error("No valid pitch values found"));
        return;
      }

      // Calculate average pitch
      const avgPitch = pitches.reduce((sum, p) => sum + p, 0) / pitches.length;
      const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : null;

      resolve({
        pitch: Math.round(avgPitch * 10) / 10, // Round to 1 decimal
        confidence: avgConfidence ? Math.round(avgConfidence * 100) / 100 : null
      });
    });
  });
}

/**
 * Detect Onsets (beat/note starts) using aubio onset command
 * Returns count of onsets and rate (onsets per second)
 */
function detectOnsetsWithAubio(audioPath) {
  return new Promise((resolve, reject) => {
    const cmd = `aubio onset "${audioPath}"`;
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Onset detection failed: ${error.message}`));
        return;
      }

      // Parse output - aubioonset outputs timestamps of detected onsets
      const lines = stdout.trim().split('\n').filter(line => line.trim() && !line.startsWith('#'));
      
      const onsets = lines.map(line => parseFloat(line.trim())).filter(t => !isNaN(t) && t >= 0);
      
      if (onsets.length === 0) {
        resolve({ count: 0, rate: 0 });
        return;
      }

      // Get duration from first and last onset, or estimate from file
      const duration = onsets[onsets.length - 1] - onsets[0];
      const rate = duration > 0 ? onsets.length / duration : 0;

      resolve({
        count: onsets.length,
        rate: Math.round(rate * 100) / 100 // Round to 2 decimals
      });
    });
  });
}

/**
 * Detect Energy/Volume levels using aubio
 * Returns average RMS energy
 */
function detectEnergyWithAubio(audioPath) {
  return new Promise((resolve, reject) => {
    // Use ffmpeg to get RMS energy since aubio doesn't have a direct energy command
    const cmd = `ffmpeg -i "${audioPath}" -af "astats=metadata=1:reset=1" -f null - 2>&1 | grep "RMS level" | tail -1`;
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error || !stdout) {
        // Fallback: use aubio's output to estimate energy from pitch confidence
        // or use a simpler method
        reject(new Error("Energy detection not available"));
        return;
      }

      // Parse RMS level (format: "RMS level: -XX.X dB")
      const match = stdout.match(/RMS level:\s*([-\d.]+)\s*dB/);
      if (match) {
        const rmsDb = parseFloat(match[1]);
        resolve(Math.round(rmsDb * 10) / 10);
      } else {
        reject(new Error("Could not parse energy level"));
      }
    });
  });
}

/**
 * Detect Silence ratio using ffmpeg
 * Returns ratio of silence (0-1)
 */
function detectSilenceWithAubio(audioPath) {
  return new Promise((resolve, reject) => {
    // Use ffmpeg silencedetect filter
    const cmd = `ffmpeg -i "${audioPath}" -af "silencedetect=noise=-30dB:duration=0.5" -f null - 2>&1 | grep -E "silence_start|silence_end"`;
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error || !stdout) {
        reject(new Error("Silence detection failed"));
        return;
      }

      // Parse silence periods
      const lines = stdout.trim().split('\n');
      const silencePeriods = [];
      let silenceStart = null;

      lines.forEach(line => {
        if (line.includes('silence_start')) {
          const match = line.match(/silence_start:\s*([\d.]+)/);
          if (match) silenceStart = parseFloat(match[1]);
        } else if (line.includes('silence_end') && silenceStart !== null) {
          const match = line.match(/silence_end:\s*([\d.]+)/);
          if (match) {
            const silenceEnd = parseFloat(match[1]);
            silencePeriods.push({ start: silenceStart, end: silenceEnd });
            silenceStart = null;
          }
        }
      });

      // Get total duration from ffprobe
      const durationCmd = `ffprobe -v quiet -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
      
      exec(durationCmd, { timeout: 10000 }, (durError, durStdout) => {
        if (durError || !durStdout) {
          reject(new Error("Could not get audio duration"));
          return;
        }

        const totalDuration = parseFloat(durStdout.trim());
        if (isNaN(totalDuration) || totalDuration <= 0) {
          reject(new Error("Invalid duration"));
          return;
        }

        const totalSilence = silencePeriods.reduce((sum, period) => sum + (period.end - period.start), 0);
        const silenceRatio = totalSilence / totalDuration;

        resolve(Math.round(silenceRatio * 1000) / 1000); // Round to 3 decimals
      });
    });
  });
}

