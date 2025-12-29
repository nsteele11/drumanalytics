import express from "express";
import fetch from "node-fetch"; // if not installed: npm install node-fetch
import { getSpotifyToken } from "./spotifyToken.js";

const router = express.Router();

/**
 * GET /api/spotify/search/artists?q=artistname
 * Returns a list of artists from Spotify based on search query
 */
router.get("/search/artists", async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.json([]); // no search term, return empty array
  }

  try {
    const token = await getSpotifyToken();

    const spotifyRes = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=artist&limit=5`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const data = await spotifyRes.json();

    // Map to simple format for frontend
    const results = data.artists.items.map(artist => ({
      spotify_artist_id: artist.id,
      name: artist.name,
      followers: artist.followers.total,
      popularity: artist.popularity,
      genres: artist.genres,
      image: artist.images[0]?.url
    }));

    res.json(results);
  } catch (err) {
    console.error("Spotify search error:", err);
    res.status(500).json({ error: "Failed to fetch artists from Spotify" });
  }
});

/**
 * GET /api/spotify/search/tracks?artistId=xxx&q=songName
 * Returns top tracks for a given artist filtered by query
 */
router.get("/search/tracks", async (req, res) => {
  const artistId = req.query.artistId;
  const query = req.query.q || "";

  if (!artistId) {
    return res.status(400).json({ error: "artistId is required" });
  }

  try {
    const token = await getSpotifyToken();

    // Spotify API: get artist's top tracks (US market)
    const spotifyRes = await fetch(
      `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const data = await spotifyRes.json();

    // Filter tracks by the search query (case-insensitive)
    const filteredTracks = data.tracks
      .filter(track => track.name.toLowerCase().includes(query.toLowerCase()))
      .map(track => ({
        id: track.id,
        name: track.name,
        album: track.album.name,
        preview_url: track.preview_url
      }));

    res.json(filteredTracks);
  } catch (err) {
    console.error("Spotify track search error:", err);
    res.status(500).json({ error: "Failed to fetch tracks from Spotify" });
  }
});

/**
 * GET /api/spotify/track/:trackId
 * Returns full track metadata including album image and artist followers
 */
router.get("/track/:trackId", async (req, res) => {
  const trackId = req.params.trackId;

  if (!trackId) {
    return res.status(400).json({ error: "trackId is required" });
  }

  try {
    const token = await getSpotifyToken();

    // Fetch track details from Spotify API
    const trackRes = await fetch(
      `https://api.spotify.com/v1/tracks/${trackId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!trackRes.ok) {
      throw new Error(`Spotify API error: ${trackRes.status}`);
    }

    const trackData = await trackRes.json();

    // Get artist details to fetch followers
    const artistId = trackData.artists[0].id;
    const artistRes = await fetch(
      `https://api.spotify.com/v1/artists/${artistId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!artistRes.ok) {
      throw new Error(`Spotify API error: ${artistRes.status}`);
    }

    const artistData = await artistRes.json();

    // Fetch audio features for the track
    let audioFeatures = null;
    let audioFeaturesErrorMsg = null;
    
    try {
      console.log(`Attempting to fetch audio features for track: ${trackId}`);
      const audioFeaturesRes = await fetch(
        `https://api.spotify.com/v1/audio-features/${trackId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      console.log(`Audio features API response status: ${audioFeaturesRes.status} ${audioFeaturesRes.statusText}`);

      if (audioFeaturesRes.ok) {
        const rawAudioFeatures = await audioFeaturesRes.json();
        console.log('Raw audio features response:', JSON.stringify(rawAudioFeatures, null, 2));
        
        // Check if the response has an error field (Spotify sometimes returns errors in the body)
        if (rawAudioFeatures.error) {
          const errorMsg = `Spotify API error: ${rawAudioFeatures.error.message || JSON.stringify(rawAudioFeatures.error)}`;
          console.error(errorMsg);
          audioFeaturesErrorMsg = errorMsg;
        } else if (rawAudioFeatures.danceability !== undefined) {
          audioFeatures = rawAudioFeatures;
          console.log('Audio features parsed successfully');
        } else {
          const errorMsg = 'Audio features response missing expected data fields';
          console.warn(errorMsg, rawAudioFeatures);
          audioFeaturesErrorMsg = errorMsg;
        }
      } else {
        // Get error details - read response as text first, then try to parse as JSON
        const errorText = await audioFeaturesRes.text();
        let errorMsg = `HTTP ${audioFeaturesRes.status} ${audioFeaturesRes.statusText}`;
        
        try {
          const errorData = JSON.parse(errorText);
          if (errorData.error) {
            errorMsg = `HTTP ${audioFeaturesRes.status}: ${errorData.error.message || errorData.error.status || JSON.stringify(errorData.error)}`;
          } else {
            errorMsg = `HTTP ${audioFeaturesRes.status}: ${errorText}`;
          }
        } catch (parseError) {
          errorMsg = `HTTP ${audioFeaturesRes.status}: ${errorText || audioFeaturesRes.statusText}`;
        }
        
        console.error(`Failed to fetch audio features for track ${trackId}:`, errorMsg);
        audioFeaturesErrorMsg = errorMsg;
      }
    } catch (audioFeaturesError) {
      const errorMsg = `Exception: ${audioFeaturesError.message}`;
      console.error('Exception while fetching audio features:', audioFeaturesError);
      console.error('Error stack:', audioFeaturesError.stack);
      audioFeaturesErrorMsg = errorMsg;
    }

    // Format response to match what frontend expects
    const response = {
      artist: {
        id: artistData.id,
        name: artistData.name,
        genres: artistData.genres || [],
        followers: artistData.followers.total
      },
      track: {
        id: trackData.id,
        name: trackData.name,
        album: trackData.album.name,
        release_date: trackData.album.release_date,
        popularity: trackData.popularity,
        duration_ms: trackData.duration_ms,
        album_image_url: trackData.album.images[0]?.url || null
      },
      audio_features: audioFeatures && audioFeatures.danceability !== undefined ? {
        danceability: audioFeatures.danceability,
        energy: audioFeatures.energy,
        key: audioFeatures.key,
        loudness: audioFeatures.loudness,
        mode: audioFeatures.mode,
        speechiness: audioFeatures.speechiness,
        acousticness: audioFeatures.acousticness,
        instrumentalness: audioFeatures.instrumentalness,
        liveness: audioFeatures.liveness,
        valence: audioFeatures.valence,
        tempo: audioFeatures.tempo,
        time_signature: audioFeatures.time_signature,
        duration_ms: audioFeatures.duration_ms,
        id: audioFeatures.id
      } : null,
      audio_features_error: audioFeaturesErrorMsg || (audioFeatures === null ? 'Audio features not available' : null)
    };

    console.log('Sending response with audio_features:', response.audio_features !== null ? 'present' : 'null');
    if (response.audio_features_error) {
      console.log('Audio features error:', response.audio_features_error);
    }
    res.json(response);
  } catch (err) {
    console.error("Spotify track metadata error:", err);
    res.status(500).json({ error: "Failed to fetch track metadata from Spotify" });
  }
});

export default router;