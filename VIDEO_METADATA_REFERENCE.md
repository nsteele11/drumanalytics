# Video Metadata Reference

This document lists all available metadata fields for each video in the DrumAnalytics system, including which fields are incorporated into the **Shock Value** score calculation.

## Metadata Categories

### 1. Basic Video Information
| Field | Type | Description | Source |
|-------|------|-------------|--------|
| `s3Key` | string | Unique identifier for the video in S3 storage | System-generated |
| `originalFilename` | string | Original filename when uploaded | User upload |
| `videoType` | string | Type of video: "Solo Mix", "Collab", "Live", "Original", "Other" | User selection |
| `uploadTimestamp` | number | Unix timestamp when video was uploaded | System-generated |
| `analyzedAt` | string | ISO timestamp when video analysis was completed | System-generated |

### 2. Spotify Metadata (if linked to Spotify)
| Field | Type | Description | Source |
|-------|------|-------------|--------|
| `artistName` | string | Name of the artist/band | Spotify API or user input |
| `trackName` | string | Name of the track/song | Spotify API or user input |
| `album` | string | Album name | Spotify API |
| `releaseDate` | string | Track release date | Spotify API |
| `popularity` | number | Track popularity score (0-100) | Spotify API |
| `artistFollowers` | number | Number of artist followers on Spotify | Spotify API |
| `genres` | array | Array of genre strings | Spotify API |
| `albumImageUrl` | string | URL to album cover image | Spotify API |

### 3. Social Media Metrics
| Field | Type | Description | Source |
|-------|------|-------------|--------|
| `igHashtags` | string | Instagram hashtags used | Manual entry |
| `tiktokHashtags` | string | TikTok hashtags used | Manual entry |
| `igViews` | number | Instagram view count | Manual entry |
| `igLikes` | number | Instagram like count | Manual entry |
| `tiktokViews` | number | TikTok view count | Manual entry |
| `tiktokLikes` | number | TikTok like count | Manual entry |
| `postedDate` | string | Date when video was posted (YYYY-MM-DD) | Manual entry |
| `metricsUpdatedAt` | string | ISO timestamp when metrics were last updated | System-generated |

### 4. Video Technical Properties (from FFprobe analysis)
| Field | Type | Description | Source |
|-------|------|-------------|--------|
| `duration` | number | Video duration in seconds | FFprobe |
| `size_mb` | number | File size in megabytes | FFprobe |
| `resolution` | string | Video resolution (e.g., "1920x1080") | Calculated from video.width × video.height |
| `videoCodec` | string | Video codec name (e.g., "h264") | FFprobe |
| `fps` | number | Frames per second | FFprobe |
| `audioCodec` | string | Audio codec name (e.g., "aac") | FFprobe |
| `sampleRate` | number | Audio sample rate in Hz | FFprobe |

### 5. Audio Analysis Features (from aubio analysis)
| Field | Type | Description | Source |
|-------|------|-------------|--------|
| `bpm` | number | Beats per minute (tempo) | aubio tempo |
| `pitch` | number | Fundamental frequency in Hz | aubio pitch |
| `pitchConfidence` | number | Confidence in pitch detection (0-1) | aubio pitch |
| `onsets` | number | Total number of detected onsets (beat/note starts) | aubio onset |
| `onsetRate` | number | Onsets per second | Calculated (onsets / duration) |
| `energy` | number | Average energy level (0-1) | aubio energy |
| `silenceRatio` | number | Ratio of silence to total duration (0-1) | aubio silence |

### 6. Shock Value Components ⚡
The following fields are **directly incorporated into the Shock Value calculation**:

| Field | Type | Description | Weight in Shock Value | Source |
|-------|------|-------------|----------------------|--------|
| `tempoSpikes` | number | Detected tempo spikes (fills) score (0-100) | **30-40%** | Custom analysis |
| `volumeSpikes` | number | Detected volume spikes (accents) score (0-100) | **0-30%** | Custom analysis |
| `unusualPatterns` | number | Unusual/complex patterns score (0-100) | **40-60%** | Custom analysis |
| `shockValue` | number | **Final composite score (0-100)** | N/A | Calculated from above |

#### Shock Value Calculation Details

The **Shock Value** is calculated as a weighted combination of three components:

```
shockValue = (tempoSpikes × weight_tempo) + 
             (volumeSpikes × weight_volume) + 
             (unusualPatterns × weight_unusual)
```

**Weight Distribution:**
- **With energy data available:**
  - Tempo Spikes: 30%
  - Volume Spikes: 30%
  - Unusual Patterns: 40%

- **Without energy data (fallback):**
  - Tempo Spikes: 40%
  - Volume Spikes: 0% (not available)
  - Unusual Patterns: 60%

**Component Definitions:**

1. **Tempo Spikes** (`tempoSpikes`): 
   - Detects sudden decreases in onset intervals (drum fills)
   - Measures rapid tempo changes that create "shock" moments
   - Score: 0-100

2. **Volume Spikes** (`volumeSpikes`):
   - Detects sudden increases in energy levels (accents)
   - Measures dynamic volume changes that stand out
   - Score: 0-100
   - Only calculated if energy data is available

3. **Unusual Patterns** (`unusualPatterns`):
   - Detects high variance in onset intervals
   - Identifies complex hits and odd timing patterns
   - Measures rhythmic complexity
   - Score: 0-100

**Shock Value Interpretation:**
- **0-30**: Low shock value - steady, predictable patterns
- **31-60**: Medium shock value - some dynamic moments
- **61-100**: High shock value - highly dynamic, complex, attention-grabbing

### 7. Derived Metrics (for Performance Analysis)
These are calculated during performance analysis and not stored in the video metadata:

| Field | Type | Description | When Available |
|-------|------|-------------|----------------|
| `engagement_proxy` | number | likes / views ratio | Performance analysis |
| `views_relative` | number | views / median(views by platform) | Performance analysis |
| `likes_relative` | number | likes / median(likes by platform) | Performance analysis |
| `high_view` | boolean | views > median(views by platform) | Performance analysis |
| `high_like` | boolean | likes > median(likes by platform) | Performance analysis |
| `performance_rank` | number | Composite rank score | Performance analysis |
| `platform` | string | "instagram" or "tiktok" | Performance analysis |

## Metadata Classification (for Analysis)

The performance analysis system also creates classifications from the raw metadata:

| Classification | Source Field(s) | Values |
|---------------|-----------------|--------|
| `day_of_week` | `postedDate` | "Sunday", "Monday", ..., "Saturday" |
| `is_weekend` | `postedDate` | true/false |
| `video_length_bucket` | `duration` | "<15s", "15–30s", "30–60s", ">60s" |
| `bpm_bucket` | `bpm` | "<100", "100–120", "120–140", ">140" |
| `energy_level` | `energy` | "low", "medium", "high" |
| `primary_genre` | `genres[0]` | Genre string |
| `has_genre` | `genres` | true/false |
| `artist_size` | `artistFollowers` | "small" (<10k), "medium" (10k-100k), "large" (>100k) |
| `track_popularity` | `popularity` | "low" (<40), "medium" (40-60), "high" (>60) |
| `has_ig_hashtags` | `igHashtags` | true/false |
| `has_tiktok_hashtags` | `tiktokHashtags` | true/false |

## Complete Metadata Example

```json
{
  "s3Key": "1703123456789-video.mp4",
  "originalFilename": "drum_cover.mp4",
  "videoType": "Solo Mix",
  "artistName": "Metallica",
  "trackName": "Enter Sandman",
  "album": "Metallica",
  "releaseDate": "1991-08-12",
  "popularity": 85,
  "artistFollowers": 12500000,
  "genres": ["metal", "thrash metal", "rock"],
  "albumImageUrl": "https://...",
  "snapshotKey": "snapshots/1703123456789-video.mp4.jpg",
  "analyzedAt": "2024-01-15T10:30:00.000Z",
  "uploadTimestamp": 1703123456789,
  
  "igHashtags": "#drumming #metal #drumcover",
  "tiktokHashtags": "#drumming #metal #fyp",
  "igViews": 15000,
  "igLikes": 450,
  "tiktokViews": 25000,
  "tiktokLikes": 1200,
  "postedDate": "2024-01-15",
  "metricsUpdatedAt": "2024-01-16T08:00:00.000Z",
  
  "duration": 45.2,
  "size_mb": 12.5,
  "resolution": "1920x1080",
  "videoCodec": "h264",
  "fps": 30,
  "audioCodec": "aac",
  "sampleRate": 44100,
  
  "bpm": 123,
  "pitch": 440.0,
  "pitchConfidence": 0.95,
  "onsets": 180,
  "onsetRate": 3.98,
  "energy": 0.75,
  "silenceRatio": 0.05,
  
  "tempoSpikes": 65.5,
  "volumeSpikes": 72.3,
  "unusualPatterns": 58.2,
  "shockValue": 65
}
```

## Notes

- **Null/Undefined Values**: Many fields may be `null` or `undefined` if:
  - The video wasn't linked to Spotify (no Spotify metadata)
  - Social media metrics haven't been entered yet
  - Audio analysis failed or wasn't performed
  - The field isn't applicable to the video type

- **Shock Value Dependencies**: 
  - Requires successful onset detection
  - Volume spikes only calculated if energy analysis succeeds
  - Falls back to tempo + unusual patterns if energy unavailable

- **Performance Analysis**: Derived metrics are calculated on-the-fly during analysis and not stored in the video metadata JSON files.


