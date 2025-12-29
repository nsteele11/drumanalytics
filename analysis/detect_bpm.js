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
        silenceRatio: null,
        tempoSpikes: null,
        volumeSpikes: null,
        unusualPatterns: null,
        shockValue: null
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

        // Detect tempo spikes, volume spikes, and unusual patterns
        try {
          const shockAnalysis = await analyzeShockValue(audioPath);
          features.tempoSpikes = shockAnalysis.tempoSpikes;
          features.volumeSpikes = shockAnalysis.volumeSpikes;
          features.unusualPatterns = shockAnalysis.unusualPatterns;
          features.shockValue = shockAnalysis.shockValue;
        } catch (shockError) {
          console.log("Shock value analysis failed:", shockError.message);
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
 * Analyze shock value by detecting tempo spikes, volume spikes, and unusual patterns
 * Returns shock value score (0-100) and individual metrics
 */
function analyzeShockValue(audioPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Get detailed onset timestamps
      let onsetData;
      try {
        onsetData = await getDetailedOnsets(audioPath);
      } catch (onsetError) {
        console.log("Onset detection failed for shock analysis:", onsetError.message);
        resolve({
          tempoSpikes: 0,
          volumeSpikes: 0,
          unusualPatterns: 0,
          shockValue: 0
        });
        return;
      }

      if (!onsetData || !onsetData.onsets || onsetData.onsets.length < 3) {
        resolve({
          tempoSpikes: 0,
          volumeSpikes: 0,
          unusualPatterns: 0,
          shockValue: 0
        });
        return;
      }

      // Get energy data over time
      let energyData = { energyValues: [], useFallback: true };
      try {
        energyData = await getEnergyOverTime(audioPath);
      } catch (energyError) {
        console.log("Energy analysis failed, using fallback:", energyError.message);
        energyData = { energyValues: [], useFallback: true };
      }
      
      // Analyze tempo spikes (fills) - sudden decreases in onset intervals
      let tempoSpikes = 0;
      try {
        tempoSpikes = detectTempoSpikes(onsetData.onsets);
        if (isNaN(tempoSpikes) || !isFinite(tempoSpikes)) tempoSpikes = 0;
      } catch (error) {
        console.log("Tempo spike detection failed:", error.message);
        tempoSpikes = 0;
      }
      
      // Analyze volume spikes (accents) - sudden increases in energy
      let volumeSpikes = 0;
      try {
        volumeSpikes = detectVolumeSpikes(energyData);
        if (isNaN(volumeSpikes) || !isFinite(volumeSpikes)) volumeSpikes = 0;
      } catch (error) {
        console.log("Volume spike detection failed:", error.message);
        volumeSpikes = 0;
      }
      
      // Analyze unusual patterns (complex hits, odd timing) - high variance in intervals
      let unusualPatterns = 0;
      try {
        unusualPatterns = detectUnusualPatterns(onsetData.onsets);
        if (isNaN(unusualPatterns) || !isFinite(unusualPatterns)) unusualPatterns = 0;
      } catch (error) {
        console.log("Unusual pattern detection failed:", error.message);
        unusualPatterns = 0;
      }
      
      // Calculate shock value score (0-100)
      // If energy data isn't available, adjust weights: tempo spikes 40%, unusual patterns 60%
      const weights = energyData.useFallback 
        ? { tempo: 0.4, volume: 0.0, unusual: 0.6 }
        : { tempo: 0.3, volume: 0.3, unusual: 0.4 };
      
      const shockValue = Math.min(100, Math.max(0, Math.round(
        (tempoSpikes * weights.tempo) + 
        (volumeSpikes * weights.volume) + 
        (unusualPatterns * weights.unusual)
      )));

      resolve({
        tempoSpikes: Math.round(Math.max(0, Math.min(100, tempoSpikes)) * 10) / 10,
        volumeSpikes: Math.round(Math.max(0, Math.min(100, volumeSpikes)) * 10) / 10,
        unusualPatterns: Math.round(Math.max(0, Math.min(100, unusualPatterns)) * 10) / 10,
        shockValue: shockValue
      });
    } catch (error) {
      console.error("Shock value analysis error:", error);
      // Return default values instead of rejecting to prevent upload failure
      resolve({
        tempoSpikes: 0,
        volumeSpikes: 0,
        unusualPatterns: 0,
        shockValue: 0
      });
    }
  });
}

/**
 * Get detailed onset timestamps
 */
function getDetailedOnsets(audioPath) {
  return new Promise((resolve, reject) => {
    const cmd = `aubio onset "${audioPath}"`;
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Onset detection failed: ${error.message}`));
        return;
      }

      const lines = stdout.trim().split('\n').filter(line => line.trim() && !line.startsWith('#'));
      const onsets = lines.map(line => parseFloat(line.trim())).filter(t => !isNaN(t) && t >= 0);
      
      resolve({ onsets: onsets });
    });
  });
}

/**
 * Get energy data over time using ffmpeg
 */
function getEnergyOverTime(audioPath) {
  return new Promise((resolve, reject) => {
    // Use ffmpeg to get RMS energy values over time (every 0.1 seconds)
    // Output to a format we can parse
    const cmd = `ffmpeg -i "${audioPath}" -af "astats=metadata=1:reset=0.1:length=0.1" -f null - 2>&1`;
    
    exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
      // ffmpeg outputs to stderr, not stdout
      const output = stderr || stdout;
      
      if (error && !output) {
        reject(new Error("Failed to get energy data"));
        return;
      }

      // Parse RMS levels (format: "RMS level: -XX.X dB")
      const lines = output.split('\n');
      const energyValues = [];
      
      lines.forEach(line => {
        // Look for RMS level patterns
        const match = line.match(/RMS level:\s*([-\d.]+)\s*dB/);
        if (match) {
          const rmsDb = parseFloat(match[1]);
          if (!isNaN(rmsDb)) {
            energyValues.push(rmsDb);
          }
        }
      });

      // If we didn't get enough data, try a simpler approach
      if (energyValues.length < 3) {
        // Fallback: use average energy as baseline and estimate spikes from onsets
        // This is a simplified approach when detailed energy data isn't available
        resolve({ energyValues: [], useFallback: true });
      } else {
        resolve({ energyValues: energyValues, useFallback: false });
      }
    });
  });
}

/**
 * Detect tempo spikes (fills) - sudden increases in onset density
 * Returns score 0-100
 */
function detectTempoSpikes(onsets) {
  if (!onsets || onsets.length < 3) return 0;

  try {
    // Calculate intervals between onsets
    const intervals = [];
    for (let i = 1; i < onsets.length; i++) {
      const interval = onsets[i] - onsets[i - 1];
      if (interval > 0 && isFinite(interval)) {
        intervals.push(interval);
      }
    }

    if (intervals.length < 2) return 0;

    // Calculate average interval
    const avgInterval = intervals.reduce((sum, i) => sum + i, 0) / intervals.length;
    
    if (!isFinite(avgInterval) || avgInterval <= 0) return 0;

    // Detect spikes: intervals that are significantly shorter than average (fills)
    let spikeCount = 0;
    let totalSpikeIntensity = 0;

    intervals.forEach(interval => {
      // If interval is less than 60% of average, it's a tempo spike
      if (interval < avgInterval * 0.6 && avgInterval > 0) {
        spikeCount++;
        // Calculate intensity: how much faster than average (0-100 scale)
        const intensity = Math.min(100, Math.max(0, ((avgInterval - interval) / avgInterval) * 200));
        if (isFinite(intensity)) {
          totalSpikeIntensity += intensity;
        }
      }
    });

    if (spikeCount === 0 || intervals.length === 0) return 0;

    // Score based on spike frequency and intensity
    const spikeFrequency = (spikeCount / intervals.length) * 100;
    const avgIntensity = totalSpikeIntensity / spikeCount;
    
    const score = Math.min(100, Math.max(0, (spikeFrequency * 0.5) + (avgIntensity * 0.5)));
    return isFinite(score) ? score : 0;
  } catch (error) {
    console.error("Error in detectTempoSpikes:", error);
    return 0;
  }
}

/**
 * Detect volume spikes (accents) - sudden increases in energy
 * Returns score 0-100
 */
function detectVolumeSpikes(energyData) {
  // If we have detailed energy data, use it
  if (energyData.energyValues && energyData.energyValues.length >= 3) {
    const energies = energyData.energyValues;
    
    // Calculate average and standard deviation
    const avgEnergy = energies.reduce((sum, e) => sum + e, 0) / energies.length;
    const variance = energies.reduce((sum, e) => sum + Math.pow(e - avgEnergy, 2), 0) / energies.length;
    const stdDev = Math.sqrt(variance);

    // Detect spikes: energy values significantly above average
    let spikeCount = 0;
    let totalSpikeIntensity = 0;

    energies.forEach(energy => {
      // If energy is more than 1.5 standard deviations above average, it's a spike
      if (energy > avgEnergy + (stdDev * 1.5)) {
        spikeCount++;
        // Calculate intensity: how much louder than average
        const intensity = Math.min(100, ((energy - avgEnergy) / Math.abs(avgEnergy)) * 50);
        totalSpikeIntensity += intensity;
      }
    });

    // Score based on spike frequency and intensity
    const spikeFrequency = (spikeCount / energies.length) * 100;
    const avgIntensity = spikeCount > 0 ? totalSpikeIntensity / spikeCount : 0;
    
    return Math.min(100, (spikeFrequency * 0.5) + (avgIntensity * 0.5));
  }
  
  // Fallback: estimate volume spikes from onset density variations
  // Higher onset density in short periods suggests volume spikes
  // This is a simplified estimation when detailed energy data isn't available
  return 0; // Return 0 if we can't analyze properly
}

/**
 * Detect unusual patterns (complex hits, odd timing) - high variance in timing
 * Returns score 0-100
 */
function detectUnusualPatterns(onsets) {
  if (!onsets || onsets.length < 3) return 0;

  try {
    // Calculate intervals between onsets
    const intervals = [];
    for (let i = 1; i < onsets.length; i++) {
      const interval = onsets[i] - onsets[i - 1];
      if (interval > 0 && isFinite(interval)) {
        intervals.push(interval);
      }
    }

    if (intervals.length < 2) return 0;

    // Calculate coefficient of variation (CV) = std dev / mean
    // Higher CV = more irregular timing
    const avgInterval = intervals.reduce((sum, i) => sum + i, 0) / intervals.length;
    
    if (!isFinite(avgInterval) || avgInterval <= 0) return 0;
    
    const variance = intervals.reduce((sum, i) => sum + Math.pow(i - avgInterval, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    
    if (!isFinite(stdDev) || stdDev <= 0) return 0;
    
    const coefficientOfVariation = stdDev / avgInterval;
    
    if (!isFinite(coefficientOfVariation)) return 0;
    
    // Also check for polyrhythmic patterns (multiple interval lengths)
    const uniqueIntervals = new Set(intervals.map(i => Math.round(i * 100) / 100));
    const intervalDiversity = (uniqueIntervals.size / intervals.length) * 100;
    
    // Score combines CV and diversity (0-100 scale)
    // CV of 0.3+ is considered unusual, scale to 100
    const cvScore = Math.min(100, Math.max(0, (coefficientOfVariation / 0.3) * 100));
    const diversityScore = Math.min(100, Math.max(0, intervalDiversity * 2));
    
    const score = Math.min(100, Math.max(0, (cvScore * 0.6) + (diversityScore * 0.4)));
    return isFinite(score) ? score : 0;
  } catch (error) {
    console.error("Error in detectUnusualPatterns:", error);
    return 0;
  }
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

