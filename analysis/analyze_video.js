import { exec } from "child_process";
import fs from "fs";

export function analyzeVideo(localPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${localPath}"`;

    exec(cmd, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      const data = JSON.parse(stdout);

      const videoStream = data.streams.find(s => s.codec_type === "video");
      const audioStream = data.streams.find(s => s.codec_type === "audio");

      resolve({
        duration: Number(data.format.duration),
        size_mb: Number(data.format.size) / 1024 / 1024,
        video: videoStream
          ? {
              codec: videoStream.codec_name,
              width: videoStream.width,
              height: videoStream.height,
              fps: eval(videoStream.r_frame_rate)
            }
          : null,
        audio: audioStream
          ? {
              codec: audioStream.codec_name,
              sample_rate: audioStream.sample_rate,
              channels: audioStream.channels
            }
          : null
      });
    });
  });
}