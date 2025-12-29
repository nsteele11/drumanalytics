# Instagram Creator Analytics

A simple web application for viewing Instagram creator analytics. This project uses a Node.js/Express backend and plain HTML/CSS/JavaScript frontend.

## Project Structure

```
DrumAnalytics/
├── server.js              # Backend server (Express)
├── package.json            # Project dependencies
├── README.md              # This file
└── frontend/              # Frontend files
    ├── index.html         # Main HTML page
    ├── style.css          # Styling for the page
    └── script.js          # JavaScript for fetching and displaying data
```

## Prerequisites

Before you start, make sure you have Node.js installed on your computer:
- Download from: https://nodejs.org/
- Choose the LTS (Long Term Support) version
- Install it following the installation wizard

To verify Node.js is installed, open a terminal/command prompt and run:
```bash
node --version
```

You should see a version number (like v18.0.0 or similar).

## Step-by-Step Setup Instructions

### Step 1: Install Dependencies

1. Open a terminal/command prompt
2. Navigate to this project folder:
   ```bash
   cd C:\Users\nstee\DrumAnalytics
   ```
3. Install the required packages:
   ```bash
   npm install
   ```
   
   This will download Express and CORS libraries that our server needs.

### Step 2: Start the Server

1. In the same terminal, run:
   ```bash
   npm start
   ```
   
   You should see:
   ```
   🚀 Server is running on http://localhost:3000
   📊 API endpoint available at http://localhost:3000/api/creators
   ```

2. **Keep this terminal window open** - the server needs to keep running!

### Step 3: Open the Website

1. Open your web browser (Chrome, Firefox, Edge, etc.)
2. Go to: `http://localhost:3000`
3. You should see the Instagram Creator Analytics page

### Step 4: Load Creator Data

1. Click the "Load Creator Data" button
2. You should see three creator cards appear with mock Instagram data

## How It Works

### Backend (server.js)
- Creates a web server using Express
- Serves the frontend files (HTML, CSS, JavaScript)
- Provides an API endpoint at `/api/creators` that returns mock Instagram creator data
- Currently uses mock data instead of the real Instagram API

### Frontend
- **index.html**: The structure of the webpage
- **style.css**: Makes the page look nice with colors, spacing, and layout
- **script.js**: Handles the button click, fetches data from the API, and displays it on the page

## API Endpoint

- **URL**: `http://localhost:3000/api/creators`
- **Method**: GET
- **Response**: JSON object containing an array of creator data

You can test this directly in your browser by visiting: `http://localhost:3000/api/creators`

## Next Steps

When you're ready to connect to the real Instagram API:
1. Get an Instagram Graph API access token from Meta
2. Replace the mock data in `server.js` with actual API calls
3. The frontend code will work the same way - it just fetches data from the endpoint

## Troubleshooting

**Problem**: "Cannot GET /" or page doesn't load
- **Solution**: Make sure the server is running (Step 2)

**Problem**: "Error: Failed to fetch" when clicking the button
- **Solution**: Check that the server is running and you see the success messages in the terminal

**Problem**: "npm: command not found"
- **Solution**: Make sure Node.js is installed correctly. Try restarting your terminal after installing Node.js

**Problem**: Port 3000 is already in use
- **Solution**: Either close the other program using port 3000, or change the PORT number in `server.js` to something else (like 3001)

## Stopping the Server

To stop the server, go to the terminal window where it's running and press:
- **Windows/Linux**: `Ctrl + C`
- **Mac**: `Cmd + C`



















