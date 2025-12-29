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
    const audioFeaturesRes = await fetch(
      `https://api.spotify.com/v1/audio-features/${trackId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    let audioFeatures = null;
    if (audioFeaturesRes.ok) {
      audioFeatures = await audioFeaturesRes.json();
    } else {
      console.warn(`Failed to fetch audio features: ${audioFeaturesRes.status}`);
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
      audio_features: audioFeatures ? {
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
      } : null
    };

    res.json(response);
  } catch (err) {
    console.error("Spotify track metadata error:", err);
    res.status(500).json({ error: "Failed to fetch track metadata from Spotify" });
  }
});

export default router;