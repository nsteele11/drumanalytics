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
 * GET /api/spotify/artist/:artistId/tracks
 * Returns all tracks for a given artist using search API with pagination
 * This gets more tracks than the top-tracks endpoint (which only returns ~10)
 */
router.get("/artist/:artistId/tracks", async (req, res) => {
  const artistId = req.params.artistId;

  if (!artistId) {
    return res.status(400).json({ error: "artistId is required" });
  }

  try {
    const token = await getSpotifyToken();

    // First, get the artist name to search for tracks
    const artistRes = await fetch(
      `https://api.spotify.com/v1/artists/${artistId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!artistRes.ok) {
      throw new Error(`Failed to get artist: ${artistRes.status}`);
    }

    const artistData = await artistRes.json();
    const artistName = artistData.name;

    // Search for tracks by this artist using search API
    // Use pagination to get more results (up to 200 tracks)
    let allTracks = [];
    let offset = 0;
    const limit = 50; // Max per request
    const maxTracks = 200; // Limit total to avoid too many API calls

    while (offset < maxTracks) {
      const searchRes = await fetch(
        `https://api.spotify.com/v1/search?q=artist:"${encodeURIComponent(artistName)}"&type=track&limit=${limit}&offset=${offset}`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (!searchRes.ok) {
        console.warn(`Failed to fetch tracks at offset ${offset}: ${searchRes.status}`);
        break;
      }

      const searchData = await searchRes.json();
      const tracks = searchData.tracks.items;

      if (tracks.length === 0) {
        break; // No more tracks
      }

      // Filter to only tracks where this artist is the primary artist
      const artistTracks = tracks
        .filter(track => track.artists.some(artist => artist.id === artistId))
        .map(track => ({
          id: track.id,
          name: track.name,
          album: track.album.name,
          preview_url: track.preview_url
        }));

      allTracks = [...allTracks, ...artistTracks];

      // If we got fewer than limit, we've reached the end
      if (tracks.length < limit) {
        break;
      }

      offset += limit;
    }

    // Remove duplicates (same track ID)
    const uniqueTracks = Array.from(
      new Map(allTracks.map(track => [track.id, track])).values()
    );

    // Sort by track name for easier browsing
    uniqueTracks.sort((a, b) => a.name.localeCompare(b.name));

    res.json(uniqueTracks);
  } catch (err) {
    console.error("Spotify artist tracks error:", err);
    res.status(500).json({ error: "Failed to fetch tracks from Spotify" });
  }
});

/**
 * GET /api/spotify/artist/:artistId/tracks/popular
 * Returns top 30 tracks for an artist sorted by popularity
 */
router.get("/artist/:artistId/tracks/popular", async (req, res) => {
  const artistId = req.params.artistId;

  if (!artistId) {
    return res.status(400).json({ error: "artistId is required" });
  }

  try {
    const token = await getSpotifyToken();

    // First, get the artist name to search for tracks
    const artistRes = await fetch(
      `https://api.spotify.com/v1/artists/${artistId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!artistRes.ok) {
      throw new Error(`Failed to get artist: ${artistRes.status}`);
    }

    const artistData = await artistRes.json();
    const artistName = artistData.name;

    // Search for tracks by this artist
    let allTracks = [];
    let offset = 0;
    const limit = 50;
    const maxTracks = 100; // Get enough to find top 30 by popularity

    while (offset < maxTracks) {
      const searchRes = await fetch(
        `https://api.spotify.com/v1/search?q=artist:"${encodeURIComponent(artistName)}"&type=track&limit=${limit}&offset=${offset}`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (!searchRes.ok) {
        console.warn(`Failed to fetch tracks at offset ${offset}: ${searchRes.status}`);
        break;
      }

      const searchData = await searchRes.json();
      const tracks = searchData.tracks.items;

      if (tracks.length === 0) {
        break;
      }

      // Filter to only tracks where this artist is the primary artist
      const artistTracks = tracks
        .filter(track => track.artists.some(artist => artist.id === artistId))
        .map(track => ({
          id: track.id,
          name: track.name,
          popularity: track.popularity,
          album: track.album.name,
          albumImageUrl: track.album.images[0]?.url || null,
          releaseDate: track.album.release_date,
          durationMs: track.duration_ms
        }));

      allTracks = [...allTracks, ...artistTracks];

      if (tracks.length < limit) {
        break;
      }

      offset += limit;
    }

    // Remove duplicates and sort by popularity (descending)
    const uniqueTracks = Array.from(
      new Map(allTracks.map(track => [track.id, track])).values()
    );

    // Sort by popularity (descending) and take top 30
    const topTracks = uniqueTracks
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 30);

    res.json(topTracks);
  } catch (err) {
    console.error("Spotify artist popular tracks error:", err);
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

/**
 * GET /api/spotify/genre/artists?genre=hip%20hop
 * Returns top 40 artists by followers for a given genre
 */
router.get("/genre/artists", async (req, res) => {
  const genre = req.query.genre;

  if (!genre) {
    return res.status(400).json({ error: "genre parameter is required" });
  }

  try {
    const token = await getSpotifyToken();
    let allArtists = [];

    // Strategy 1: Search with genre filter (exact match)
    try {
      const exactRes = await fetch(
        `https://api.spotify.com/v1/search?q=genre:"${encodeURIComponent(genre)}"&type=artist&limit=50`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (exactRes.ok) {
        const exactData = await exactRes.json();
        allArtists = [...allArtists, ...exactData.artists.items];
      }
    } catch (err) {
      console.warn("Exact genre search failed:", err);
    }

    // Strategy 2: Search with genre as a term (broader match) and filter by genre tags
    try {
      const broadRes = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(genre)}&type=artist&limit=50`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (broadRes.ok) {
        const broadData = await broadRes.json();
        // Filter artists that have the genre in their genres array
        const genreArtists = broadData.artists.items.filter(artist => 
          artist.genres && artist.genres.some(g => 
            g.toLowerCase().includes(genre.toLowerCase()) || 
            genre.toLowerCase().includes(g.toLowerCase())
          )
        );
        allArtists = [...allArtists, ...genreArtists];
      }
    } catch (err) {
      console.warn("Broad genre search failed:", err);
    }

    // Remove duplicates
    const uniqueArtists = Array.from(
      new Map(allArtists.map(artist => [artist.id, artist])).values()
    );

    // Filter to only artists that actually have this genre in their tags
    const genreFiltered = uniqueArtists.filter(artist => 
      artist.genres && artist.genres.length > 0 && artist.genres.some(g => {
        const genreLower = genre.toLowerCase();
        const gLower = g.toLowerCase();
        return gLower.includes(genreLower) || genreLower.includes(gLower) || 
               gLower === genreLower;
      })
    );

    // Map and sort by followers (descending)
    const results = genreFiltered
      .map(artist => ({
        id: artist.id,
        name: artist.name,
        followers: artist.followers.total,
        popularity: artist.popularity,
        genres: artist.genres,
        image: artist.images[0]?.url
      }))
      .sort((a, b) => b.followers - a.followers)
      .slice(0, 40); // Top 40

    res.json(results);
  } catch (err) {
    console.error("Spotify genre artists search error:", err);
    res.status(500).json({ error: "Failed to fetch artists by genre from Spotify" });
  }
});

/**
 * GET /api/spotify/genre/tracks?genre=hip%20hop
 * Returns top 100 tracks by popularity for a given genre
 * Uses pagination to fetch tracks 1-50 and 51-100
 */
router.get("/genre/tracks", async (req, res) => {
  const genre = req.query.genre;

  if (!genre) {
    return res.status(400).json({ error: "genre parameter is required" });
  }

  try {
    const token = await getSpotifyToken();
    let allTracks = [];

    // Strategy 1: Get top artists for this genre, then get their popular tracks
    // This is more reliable since genres are associated with artists
    try {
      // Get artists with this genre - use multiple pages to get more artists
      let allGenreArtists = [];
      for (let offset = 0; offset < 200; offset += 50) {
        const artistsRes = await fetch(
          `https://api.spotify.com/v1/search?q=genre:"${encodeURIComponent(genre)}"&type=artist&limit=50&offset=${offset}`,
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );

        if (!artistsRes.ok) break;

        const artistsData = await artistsRes.json();
        const genreArtists = artistsData.artists.items
          .filter(artist => artist.genres && artist.genres.some(g => {
            const genreLower = genre.toLowerCase();
            const gLower = g.toLowerCase();
            return gLower.includes(genreLower) || genreLower.includes(gLower) || gLower === genreLower;
          }));

        allGenreArtists = [...allGenreArtists, ...genreArtists];

        if (artistsData.artists.items.length < 50) break;
      }

      // Sort by followers and take top 50 artists
      const topArtists = allGenreArtists
        .sort((a, b) => b.followers.total - a.followers.total)
        .slice(0, 50);

      console.log(`Found ${topArtists.length} artists for genre "${genre}"`);

      // Get top tracks for each artist (limit to avoid too many API calls)
      const artistPromises = topArtists.slice(0, 50).map(async (artist) => {
        try {
          const topTracksRes = await fetch(
            `https://api.spotify.com/v1/artists/${artist.id}/top-tracks?market=US`,
            {
              headers: {
                Authorization: `Bearer ${token}`
              }
            }
          );

          if (topTracksRes.ok) {
            const topTracksData = await topTracksRes.json();
            return topTracksData.tracks.map(track => ({
              id: track.id,
              name: track.name,
              artist: track.artists[0]?.name || 'Unknown',
              artistId: track.artists[0]?.id,
              popularity: track.popularity,
              album: track.album.name,
              albumImageUrl: track.album.images[0]?.url || null,
              releaseDate: track.album.release_date,
              durationMs: track.duration_ms
            }));
          }
          return [];
        } catch (err) {
          console.warn(`Failed to get tracks for artist ${artist.id}:`, err);
          return [];
        }
      });

      // Wait for all artist track requests
      const tracksArrays = await Promise.all(artistPromises);
      allTracks = tracksArrays.flat();
      console.log(`Got ${allTracks.length} tracks from artists`);

    } catch (err) {
      console.warn("Artist-based genre search failed:", err);
    }

    // Strategy 2: Direct track search with pagination as supplement
    try {
      for (let offset = 0; offset < 200 && allTracks.length < 200; offset += 50) {
        const directRes = await fetch(
          `https://api.spotify.com/v1/search?q=genre:"${encodeURIComponent(genre)}"&type=track&limit=50&offset=${offset}`,
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );

        if (!directRes.ok) break;

        const directData = await directRes.json();
        if (directData.tracks.items.length === 0) break;

        const directTracks = directData.tracks.items.map(track => ({
          id: track.id,
          name: track.name,
          artist: track.artists[0]?.name || 'Unknown',
          artistId: track.artists[0]?.id,
          popularity: track.popularity,
          album: track.album.name,
          albumImageUrl: track.album.images[0]?.url || null,
          releaseDate: track.album.release_date,
          durationMs: track.duration_ms
        }));
        allTracks = [...allTracks, ...directTracks];

        if (directData.tracks.items.length < 50) break;
      }
      console.log(`Total tracks after direct search: ${allTracks.length}`);
    } catch (err) {
      console.warn("Direct track search failed:", err);
    }

    // Remove duplicates, sort by popularity, and take top 100
    const uniqueTracks = Array.from(
      new Map(allTracks.map(track => [track.id, track])).values()
    );

    const results = uniqueTracks
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 100); // Top 100

    console.log(`Returning ${results.length} unique tracks for genre "${genre}"`);
    res.json(results);
  } catch (err) {
    console.error("Spotify genre tracks search error:", err);
    res.status(500).json({ error: "Failed to fetch tracks by genre from Spotify" });
  }
});

export default router;