let accessToken; // global variable to store token after OAuth login

require('dotenv').config({ path: './.env' });

const express = require('express');
const axios = require('axios');
const fs = require('fs'); // to read/write token file
const tokenFile = './access_token.json'; // file to save the token

const app = express();
const PORT = 3000;

try {
    const tokenData = fs.readFileSync(tokenFile, 'utf-8');
    accessToken = JSON.parse(tokenData).accessToken;
    console.log('Loaded saved access token');
  } catch (err) {
    console.log('No saved access token found');
  }

app.get('/', (req, res) => {
  res.send('DrumAnalytics backend running');
});

app.get('/auth/facebook/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).send('No code received');
  }

  try {
    const tokenResponse = await axios.get(
      'https://graph.facebook.com/v19.0/oauth/access_token',
      {
        params: {
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          redirect_uri: process.env.FB_REDIRECT_URI,
          code: code
        }
      }
    );

    accessToken = tokenResponse.data.access_token;
    console.log('ACCESS TOKEN:', accessToken);
    
    // Save token to file
    fs.writeFileSync(tokenFile, JSON.stringify({ accessToken }), 'utf-8');
    console.log('Access token saved to file');

    res.send(`
      <h1>Login Success</h1>
      <p>Access token received. Check terminal.</p>
    `);
} catch (err) {
    console.log('FULL ERROR OBJECT:');
    console.log(err.response?.data || err);
    res.status(500).send('Token exchange failed — check terminal');
  }
});

app.get('/me/accounts', async (req, res) => {
    try {
      if (!accessToken) {
        return res.status(400).send('Access token not found. Login first.');
      }
  
      const pagesResponse = await axios.get(
        'https://graph.facebook.com/v19.0/me/accounts',
        {
          params: {
            access_token: accessToken
          }
        }
      );
  
      console.log('Pages Response:', pagesResponse.data);
      res.json(pagesResponse.data);
  
    } catch (err) {
      console.error('Error fetching pages:', err.response?.data || err);
      res.status(500).send('Failed to fetch Pages');
    }
  });

  /* =========================
   NEW ROUTE #4
   DEBUG TOKEN PERMISSIONS
   ========================= */
app.get('/debug/token', async (req, res) => {
    try {
      const response = await axios.get(
        'https://graph.facebook.com/debug_token',
        {
          params: {
            input_token: accessToken,
            access_token: `${process.env.FB_APP_ID}|${process.env.FB_APP_SECRET}`
          }
        }
      );
  
      res.json(response.data);
    } catch (err) {
      console.error(err.response?.data || err);
      res.status(500).send('Debug failed');
    }
  });

/* =========================
   NEW ROUTE #5
   FETCH BUSINESSES
   ========================= */
   app.get('/me/businesses', async (req, res) => {
    try {
      const response = await axios.get(
        'https://graph.facebook.com/v19.0/me/businesses',
        {
          params: {
            access_token: accessToken
          }
        }
      );
  
      res.json(response.data);
    } catch (err) {
      console.error(err.response?.data || err);
      res.status(500).send('Failed to fetch businesses');
    }
  });

/* =========================
   NEW ROUTE #6
   FETCH PAGES FROM BUSINESS
   ========================= */
   app.get('/business/:id/pages', async (req, res) => {
    try {
      const response = await axios.get(
        `https://graph.facebook.com/v19.0/${req.params.id}/owned_pages`,
        {
          params: {
            access_token: accessToken
          }
        }
      );
  
      res.json(response.data);
    } catch (err) {
        res.json(err.response?.data || err);
      }

  });

/* =========================
   FETCH IG BUSINESS ACCOUNT
   ========================= */
   app.get('/page/:id/instagram', async (req, res) => {
    try {
      const response = await axios.get(
        `https://graph.facebook.com/v19.0/${req.params.id}`,
        {
          params: {
            fields: 'instagram_business_account',
            access_token: accessToken
          }
        }
      );
  
      res.json(response.data);
    } catch (err) {
      console.error(err.response?.data || err);
      res.status(500).send('Failed to fetch Instagram account');
    }
  });

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});