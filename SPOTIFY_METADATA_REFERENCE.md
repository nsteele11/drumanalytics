# Spotify Metadata Available Through Current Implementation

This document lists all metadata currently available through your Spotify API integration.

## Endpoint: `/api/spotify/search/artists?q={query}`

**Currently Returned:**
- `spotify_artist_id` - Artist's unique Spotify ID
- `name` - Artist name
- `followers` - Total number of followers
- `popularity` - Popularity score (0-100)
- `genres` - Array of genre strings
- `image` - Artist profile image URL (first/largest image)

## Endpoint: `/api/spotify/search/tracks?artistId={id}&q={query}`

**Currently Returned:**
- `id` - Track's unique Spotify ID
- `name` - Track name
- `album` - Album name
- `preview_url` - URL for 30-second audio preview (if available)

## Endpoint: `/api/spotify/track/{trackId}`

**Currently Returned:**

### Artist Object:
- `artist.id` - Artist's unique Spotify ID
- `artist.name` - Artist name
- `artist.genres` - Array of genre strings
- `artist.followers` - Total number of followers

### Track Object:
- `track.id` - Track's unique Spotify ID
- `track.name` - Track name
- `track.album` - Album name
- `track.release_date` - Album release date
- `track.popularity` - Popularity score (0-100)
- `track.duration_ms` - Track duration in milliseconds
- `track.album_image_url` - Album cover image URL (largest/first image)

## Metadata Stored in Backend (server2.js)

When uploading, the following metadata is stored:

### Artist:
- `id` - Artist ID
- `name` - Artist name
- `genres` - Array of genres
- `followers` - Follower count

### Track:
- `id` - Track ID
- `name` - Track name
- `album` - Album name
- `release_date` - Release date
- `popularity` - Popularity score
- `duration_ms` - Duration in milliseconds

---

## Additional Metadata Available from Spotify API (Not Currently Extracted)

The following metadata is available from the Spotify API but is **NOT currently being extracted**:

### Track Metadata (Additional):
- `explicit` - Boolean indicating explicit content
- `track_number` - Track position in album
- `disc_number` - Disc number (for multi-disc albums)
- `available_markets` - Array of country codes where track is available
- `external_urls` - Object with Spotify and external URLs
- `is_local` - Boolean if track is a local file
- `is_playable` - Boolean indicating if track can be played
- `linked_from` - Object with track that this track was linked from
- `restrictions` - Object with market restrictions
- `preview_url` - 30-second preview URL
- `uri` - Spotify URI for the track
- `external_ids` - Object with ISRC, EAN, UPC codes

### Album Metadata (Additional from track.album object):
- `album.id` - Album's unique Spotify ID
- `album.album_type` - Type (album, single, compilation)
- `album.total_tracks` - Total number of tracks
- `album.release_date_precision` - Precision level (year, month, day)
- `album.images` - Full array of images (different sizes)
- `album.available_markets` - Array of available markets
- `album.external_urls` - Album URLs
- `album.uri` - Spotify URI

### Artist Metadata (Additional):
- `artist.popularity` - Artist popularity score (0-100)
- `artist.images` - Full array of artist images (different sizes)
- `artist.external_urls` - Artist URLs
- `artist.uri` - Spotify URI
- `artist.href` - API endpoint URL for artist

### Audio Features (Requires separate API call):
These require calling `/v1/audio-features/{trackId}`:
- `danceability` - Danceability score (0.0-1.0)
- `energy` - Energy score (0.0-1.0)
- `key` - Musical key (0-11)
- `loudness` - Loudness in dB
- `mode` - Modality (0=minor, 1=major)
- `speechiness` - Speechiness score (0.0-1.0)
- `acousticness` - Acousticness score (0.0-1.0)
- `instrumentalness` - Instrumentalness score (0.0-1.0)
- `liveness` - Liveness score (0.0-1.0)
- `valence` - Positiveness score (0.0-1.0)
- `tempo` - Tempo in BPM
- `time_signature` - Time signature (3-7)

---

## Summary

**Currently Available:** 11 metadata fields (5 artist + 6 track)

**Potentially Available:** 30+ additional metadata fields + audio features




