// Get references to HTML elements we'll need to interact with
const fetchButton = document.getElementById('fetchButton');
const creatorsContainer = document.getElementById('creatorsContainer');
const loading = document.getElementById('loading');
const error = document.getElementById('error');

// This function fetches creator data from our backend API
async function fetchCreators() {
    try {
        // Show loading indicator and hide error message
        loading.classList.remove('hidden');
        error.classList.add('hidden');
        creatorsContainer.innerHTML = ''; // Clear previous results
        
        // Make a request to our backend API endpoint
        // 'await' means we wait for the response before continuing
        const response = await fetch('http://localhost:3000/api/creators');
        
        // Check if the response was successful (status code 200)
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        // Convert the response from JSON format to a JavaScript object
        const result = await response.json();
        
        // Hide loading indicator
        loading.classList.add('hidden');
        
        // Check if we got data back
        if (result.success && result.data) {
            // Display each creator in a card
            displayCreators(result.data);
        } else {
            throw new Error('No data received from API');
        }
        
    } catch (err) {
        // If something goes wrong, show an error message
        loading.classList.add('hidden');
        error.classList.remove('hidden');
        error.textContent = `Error: ${err.message}. Make sure the server is running!`;
        console.error('Error fetching creators:', err);
    }
}

// This function creates and displays creator cards on the page
function displayCreators(creators) {
    // Clear any existing content
    creatorsContainer.innerHTML = '';
    
    // Loop through each creator and create a card for them
    creators.forEach(creator => {
        // Create a new div element for the card
        const card = document.createElement('div');
        card.className = 'creator-card';
        
        // Format large numbers with commas (e.g., 125000 becomes 125,000)
        const formatNumber = (num) => num.toLocaleString();
        
        // Create the HTML content for this card
        card.innerHTML = `
            <img src="${creator.profilePicture}" alt="${creator.name}'s profile picture">
            <h2>${creator.name}</h2>
            <p class="username">@${creator.username}</p>
            <p class="bio">${creator.bio}</p>
            <div class="creator-stats">
                <div class="stat">
                    <div class="stat-value">${formatNumber(creator.followers)}</div>
                    <div class="stat-label">Followers</div>
                </div>
                <div class="stat">
                    <div class="stat-value">${formatNumber(creator.following)}</div>
                    <div class="stat-label">Following</div>
                </div>
                <div class="stat">
                    <div class="stat-value">${formatNumber(creator.posts)}</div>
                    <div class="stat-label">Posts</div>
                </div>
            </div>
            <div class="engagement-rate">
                <div class="value">${creator.engagementRate}%</div>
                <div class="stat-label">Engagement Rate</div>
            </div>
        `;
        
        // Add the card to the container
        creatorsContainer.appendChild(card);
    });
}

// Add an event listener to the button
// When the button is clicked, call the fetchCreators function
fetchButton.addEventListener('click', fetchCreators);















