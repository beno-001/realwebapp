// app.js
const socket = io(); // Connects to the Socket.IO server

// --- 1. UTILITY FUNCTIONS ---

/**
 * Renders a new post dynamically into the feed.
 * @param {object} post - { postId, text, imageUrl, likesCount }
 */
function renderPost(post) {
    const postsContainer = document.getElementById('posts-container');
    const newPostElement = document.createElement('div');
    newPostElement.className = 'post';
    newPostElement.setAttribute('data-post-id', post.postId);

    // In a real app, you'd add the actual image/video element here
    // For now, just the text and like button:
    newPostElement.innerHTML = `
        <p class="story-text">${post.text}</p>
        ${post.imageUrl ? `<img src="${post.imageUrl}" style="max-width:100%; border-radius: 8px; margin-top: 10px;">` : ''}
        <div class="actions">
            <span class="likes-count" id="likes-${post.postId}">${post.likesCount || 0}</span> Likes
            <button class="like-btn" onclick="sendLike('${post.postId}')">❤️ Like</button>
        </div>
    `;
    // Prepend to show newest first
    postsContainer.prepend(newPostElement);
}

// --- 2. AUTHENTICATION (Placeholder) ---

function loginUser() {
    // In a real app: POST fetch to /api/login, save JWT token, hide modal
    console.log('Attempting to log in...');
    document.getElementById('auth-modal').style.display = 'none';
    document.getElementById('logout-btn').style.display = 'inline-block';
    document.getElementById('for-you-feed').style.display = 'block';
    alert('Logged in successfully (Placeholder)');
}

// --- 3. UPLOAD AND POSTING ---

function uploadPost() {
    const fileInput = document.getElementById('photo-upload');
    const storyText = document.getElementById('story-text').value;

    if (!storyText && !fileInput.files.length) {
        alert('Please add a story or upload a picture!');
        return;
    }

    // In a real app:
    // 1. Upload the file to the server (e.g., via FormData POST to /api/upload)
    // 2. Server saves file, returns the image URL.
    // 3. Then, emit the post details to the server.

    const newPostData = {
        postId: Date.now().toString(), // Unique ID
        userId: 'currentUser123',
        text: storyText,
        imageUrl: fileInput.files.length ? '/path/to/uploaded/image.jpg' : null, // Placeholder URL
        likesCount: 0
    };

    // Emit the new post event to the server to broadcast
    socket.emit('newPost', newPostData);

    // Clear the input fields
    document.getElementById('story-text').value = '';
    fileInput.value = '';

    console.log('Post sent for broadcast.');
}


// --- 4. REAL-TIME SOCKET.IO HANDLERS ---

// Listener for a new post broadcast from the server
socket.on('updateFeed', (post) => {
    console.log('Received new post for feed:', post);
    renderPost(post);
});

// Listener for a real-time like update
socket.on('likeUpdate', (data) => {
    console.log(`Post ${data.postId} now has ${data.newCount} likes.`);
    const likeCountSpan = document.getElementById(`likes-${data.postId}`);
    if (likeCountSpan) {
        likeCountSpan.textContent = data.newCount;
        // Visual feedback
        likeCountSpan.style.color = 'var(--primary-color)';
        setTimeout(() => likeCountSpan.style.color = 'var(--secondary-color)', 500);
    }
});

// Listener for chat messages (placeholder)
socket.on('newChatMessage', (msg) => {
    // Add message to the chat window DOM
    const chatWindow = document.getElementById('chat-window');
    const msgElement = document.createElement('p');
    msgElement.textContent = `${msg.user}: ${msg.message}`;
    chatWindow.appendChild(msgElement);
});

// --- 5. USER INTERACTION FUNCTIONS ---

function sendLike(postId) {
    // In a real app, you'd send the current user's ID too
    socket.emit('likePost', postId, 'currentUser123');
    console.log(`Sending like for post: ${postId}`);
}

function sendChatMessage() {
    const chatInput = document.getElementById('chat-input');
    const message = chatInput.value.trim();
    if (message) {
        const msgData = {
            user: 'currentUser123',
            message: message,
            // In a private chat, you'd include 'recipientId'
        };
        socket.emit('chatMessage', msgData); // Using a public 'chatMessage' for simplicity
        chatInput.value = '';
    }
}


// --- INITIALIZATION ---
// Show the login modal on load
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('auth-modal').style.display = 'block';
    document.getElementById('for-you-feed').style.display = 'none';
});