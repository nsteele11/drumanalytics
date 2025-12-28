import fetch from "node-fetch"; // if not installed: npm install node-fetch

let token = null;
let expiresAt = 0;

export async function getSpotifyToken() {
  // Return cached token if still valid
  if (token && Date.now() < expiresAt) {
    return token;
  }

  // Request new token from Spotify
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(
          process.env.SPOTIFY_CLIENT_ID +
          ":" +
          process.env.SPOTIFY_CLIENT_SECRET
        ).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await response.json();

  token = data.access_token;
  // Subtract 60 seconds to make sure we refresh before expiry
  expiresAt = Date.now() + (data.expires_in - 60) * 1000;

  return token;
}