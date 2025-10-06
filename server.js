// --- ENVIRONMENT CONFIGURATION ---
// 1. Import and run dotenv to load variables from the .env file


// --- Dependencies ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid'); // Production-ready UUID for IDs
const db = require('./db'); // Import the new MySQL database module

// Install this package: npm install uuid

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 2. Use process.env for PORT, falling back to 3000 if not set
const PORT = process.env.PORT || 3000;
const saltRounds = 10;

// --- Middleware ---
app.use(express.json());
// Assuming 'public' contains index.html, otherwise remove the 'public' if index.html is in the root
app.use(express.static('public'));

// --- Helper Functions ---

/**
 * Broadcasts the current list of online users to all connected clients.
 */
const broadcastOnlineUsers = async () => {
    const users = await db.getOnlineUsers();
    // Exclude the socketId from the broadcast payload for security/cleanliness
    const userPayload = users.map(u => ({ userId: u.userId, username: u.username }));
    io.emit('onlineUsers', userPayload);
    console.log(`Broadcasting ${userPayload.length} online users.`);
};


// --- API Routes ---

// AUTH: Signup endpoint (UPDATED: Handle profilePicUrl)
app.post('/api/signup', async (req, res) => {
    const { email, password, username, profilePicUrl } = req.body;
    if (!email || !password || !username) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        const userId = uuidv4(); // Use production-ready UUID

        const success = await db.createUser(userId, email, hashedPassword, username, profilePicUrl);

        if (success) {
            // UPDATED: Return profilePicUrl
            res.json({ success: true, message: 'User created successfully.', token: 'fake-jwt-token', userId, username, profilePicUrl });
        } else {
             // If success is false, there was likely a database issue (though not necessarily a duplicate entry)
             return res.status(500).json({ success: false, message: 'Failed to create user due to database issue.' });
        }
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Email or Username already taken.' });
        }
        console.error('Signup error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// AUTH: Login endpoint (UPDATED: Return profilePicUrl)
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    try {
        const user = await db.findUserByEmail(email);

        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        const match = await bcrypt.compare(password, user.password_hash);
        if (match) {
            // UPDATED: Return profilePicUrl
            res.json({ success: true, message: 'Login successful.', token: 'fake-jwt-token', userId: user.user_id, username: user.username, profilePicUrl: user.profilePicUrl });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// POST: Upload a new post (UPDATED: Using cleaner data model)
app.post('/api/post', async (req, res) => {
    // Rely on db to fetch username/profilePicUrl from users table for feed fetch
    const { user_id, content, media_url } = req.body;
    if (!user_id || (!content && !media_url)) {
        return res.status(400).json({ success: false, message: 'Content or media is required.' });
    }

    try {
        const postId = uuidv4();
        // CHANGED: Removed username and profilePicUrl from db.createPost call
        const success = await db.createPost(postId, user_id, content, media_url);

        if (success) {
            // Re-destructure from req.body for *immediate* socket broadcast
            const { username, profilePicUrl } = req.body;
            const newPost = { id: postId, user_id, username, content, media_path: media_url, likesCount: 0, profilePicUrl };
            io.emit('updateFeed', newPost); // Broadcast the new post to all connected clients
            res.json({ success: true, message: 'Post created.', post: newPost });
        } else {
            return res.status(500).json({ success: false, message: 'Failed to create post.' });
        }
    } catch (error) {
        console.error('Post creation error:', error);
        res.status(500).json({ success: false, message: 'Database error creating post.' });
    }
});

// GET: Fetch all posts for the feed (UPDATED: Check for user's like status)
app.get('/api/posts', async (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).json({ success: false, message: 'User ID is required.' });
    }
    try {
        const rawPosts = await db.getAllPosts();
        // Map posts to determine if the current user has liked it
        const posts = await Promise.all(rawPosts.map(async post => {
            const hasLiked = await db.getLike(post.id, userId);
            return {
                ...post,
                id: post.id,
                isLiked: !!hasLiked,
                like_count: parseInt(post.likesCount)
            };
        }));
        res.json({ success: true, posts });
    } catch (error) {
        console.error('Feed fetch error:', error);
        res.status(500).json({ success: false, message: 'Database error fetching posts.' });
    }
});

// NEW: POST: Save a comment
app.post('/api/comment', async (req, res) => {
    // Keeping username/profilePicUrl in req.body for socket broadcast, but not saving to comment table
    const { post_id, user_id, content } = req.body;
    if (!post_id || !user_id || !content) {
        return res.status(400).json({ success: false, message: 'Post ID, User ID, and Content are required.' });
    }

    try {
        const commentId = uuidv4();
        // CHANGED: Removed username and profilePicUrl from db.createComment call
        const success = await db.createComment(commentId, post_id, user_id, content);

        if (success) {
            // Re-destructure from req.body for socket broadcast
            const { username, profilePicUrl } = req.body;
            const newComment = { id: commentId, post_id, user_id, username, content, profilePicUrl, created_at: new Date().toISOString() };
            io.emit('commentUpdate', newComment); // Broadcast the new comment
            res.json({ success: true, message: 'Comment posted.', comment: newComment });
        } else {
            return res.status(500).json({ success: false, message: 'Failed to save comment.' });
        }
    } catch (error) {
        console.error('Comment posting error:', error);
        res.status(500).json({ success: false, message: 'Database error posting comment.' });
    }
});

// NEW: GET: Fetch comments for a post
app.get('/api/comments/:postId', async (req, res) => {
    const { postId } = req.params;

    try {
        const comments = await db.getCommentsByPostId(postId);
        res.json({ success: true, comments });
    } catch (error) {
        console.error('Comments fetch error:', error);
        res.status(500).json({ success: false, message: 'Database error fetching comments.' });
    }
});

// GET: Fetch private chat history (FIXED: Route name matches client)
// Client endpoint: /api/chathistory?user1Id=${currentUser.id}&user2Id=${recipientId}
app.get('/api/chathistory', async (req, res) => {
    const { user1Id, user2Id } = req.query;

    if (!user1Id || !user2Id) {
        return res.status(400).json({ success: false, message: 'User1 ID and User2 ID are required.' });
    }

    try {
        const history = await db.getChatHistory(user1Id, user2Id);
        res.json({ success: true, history });
    } catch (error) {
        console.error('Chat history fetch error:', error);
        res.status(500).json({ success: false, message: 'Database error fetching chat history.' });
    }
});


// --- Socket.IO Connection and Handlers ---

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // --- 1. User Presence Tracking (NO CHANGE) ---

    socket.on('userOnline', async ({ userId, username }) => {
        if (!userId || !username) {
            console.warn('userOnline event missing userId or username.');
            return;
        }

        try {
            await db.setOnlineStatus(userId, username, socket.id);
            socket.userId = userId; // Store userId on the socket for easier lookup
            console.log(`User ${username} (${userId}) is now online.`);
            broadcastOnlineUsers();
        } catch (err) {
            console.error("Error setting user online status:", err);
        }
    });

    socket.on('userOffline', async ({ userId }) => {
        if (!userId) return;
        try {
            await db.removeOnlineStatusByUserId(userId);
            console.log(`User ${userId} explicitly went offline.`);
            delete socket.userId;
            broadcastOnlineUsers();
        } catch (err) {
            console.error("Error removing user status:", err);
        }
    });

    socket.on('disconnect', async () => {
        if (socket.userId) {
            try {
                await db.removeOnlineStatusBySocketId(socket.id);
                console.log(`User ${socket.userId} disconnected.`);
                broadcastOnlineUsers();
            } catch (err) {
                console.error("Error removing user status on disconnect:", err);
            }
        }
        console.log('User disconnected:', socket.id);
    });

    // --- 2. Private Messaging (NO CHANGE) ---

    socket.on('privateMessage', async (msg) => {
        const { senderId, recipientId, message } = msg;

        if (!senderId || !recipientId || !message) {
            console.warn('Invalid private message data received.');
            return;
        }

        try {
            await db.savePrivateMessage(senderId, recipientId, message);

            const fullMsg = {
                sender_id: senderId.toString(),
                recipient_id: recipientId.toString(),
                message,
                timestamp: new Date().toISOString()
            };

            // 2. Find recipient's socket ID and send
            const recipientSocketId = await db.getRecipientSocketId(recipientId);
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('newPrivateMessage', fullMsg);
                console.log(`Private message sent to ${recipientId}.`);
            } else {
                console.log(`Recipient ${recipientId} not found online. Message saved but not delivered in real-time.`);
            }

            // 3. Echo the message back to the sender
            socket.emit('newPrivateMessage', fullMsg);
        } catch (err) {
            console.error("Error handling private message:", err);
        }
    });

    // --- 3. Feed and Likes (REMOVED redundant newPost handler) ---

    // Note: newPost broadcast is now handled in the /api/post route after saving to DB.

    socket.on('likePost', async (data) => {
        const { postId, userId } = data;

        try {
            const row = await db.getLike(postId, userId);

            if (row) {
                await db.removeLike(postId, userId); // Unlike
            } else {
                await db.addLike(postId, userId); // Like
            }

            // Get the new count and broadcast
            const newCount = await db.getLikeCount(postId);
            io.emit('likeUpdate', { postId, newCount });
        } catch (err) {
            console.error("Error handling likePost:", err);
        }
    });
});

// --- Server Start ---
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});