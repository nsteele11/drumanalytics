// Import the Express library - this is what we use to create our web server
const express = require('express');
// Import CORS - this allows our frontend to make requests to our backend
const cors = require('cors');

// Create an Express application (this is our server)
const app = express();
// Set the port number - this is where our server will listen for requests
const PORT = 3000;

// Enable CORS so our frontend can communicate with the backend
app.use(cors());
// This allows Express to parse JSON data from requests
app.use(express.json());

// Serve static files (HTML, CSS, JavaScript) from the 'frontend' folder
// This means when someone visits our website, they'll see the files in the frontend folder
app.use(express.static('frontend'));

// Mock Instagram creator data - this simulates what we'll get from the real Instagram API later
const mockCreators = [
  {
    id: '1',
    username: 'travel_photographer',
    name: 'Sarah Johnson',
    followers: 125000,
    following: 850,
    posts: 342,
    profilePicture: 'https://via.placeholder.com/150',
    bio: 'Travel enthusiast | Photography lover | Adventure seeker',
    engagementRate: 4.2
  },
  {
    id: '2',
    username: 'fitness_coach',
    name: 'Mike Chen',
    followers: 89000,
    following: 1200,
    posts: 567,
    profilePicture: 'https://via.placeholder.com/150',
    bio: 'Certified Personal Trainer | Helping you reach your fitness goals',
    engagementRate: 5.8
  },
  {
    id: '3',
    username: 'foodie_adventures',
    name: 'Emma Rodriguez',
    followers: 210000,
    following: 450,
    posts: 789,
    profilePicture: 'https://via.placeholder.com/150',
    bio: 'Food blogger | Recipe creator | Restaurant reviewer',
    engagementRate: 6.1
  }
];

// Define an API endpoint - this is a route that returns data
// When someone visits http://localhost:3000/api/creators, they'll get the mock data
app.get('/api/creators', (req, res) => {
  // req = request (incoming data)
  // res = response (what we send back)
  
  // Send the mock creators data as JSON
  res.json({
    success: true,
    data: mockCreators,
    message: 'Mock Instagram creator data retrieved successfully'
  });
});

// Start the server and make it listen on the specified port
app.listen(PORT, () => {
  // This message will appear in the terminal when the server starts
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log(`📊 API endpoint available at http://localhost:${PORT}/api/creators`);
});



















