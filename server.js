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

// AUTH: Signup endpoint
app.post('/api/signup', async (req, res) => {
    const { email, password, username } = req.body;
    if (!email || !password || !username) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        const userId = uuidv4(); // Use production-ready UUID

        const success = await db.createUser(userId, email, hashedPassword, username);

        if (success) {
            res.json({ success: true, message: 'User created successfully.', token: 'fake-jwt-token', userId, username });
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

// AUTH: Login endpoint
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
            res.json({ success: true, message: 'Login successful.', token: 'fake-jwt-token', userId: user.user_id, username: user.username });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// POST: Upload a new post
app.post('/api/post', async (req, res) => {
    const { user_id, username, content, media_url } = req.body;
    if (!user_id || (!content && !media_url)) {
        return res.status(400).json({ success: false, message: 'Content or media is required.' });
    }

    try {
        const postId = uuidv4();
        const success = await db.createPost(postId, user_id, username, content, media_url);

        if (success) {
            const newPost = { id: postId, user_id, username, content, media_url, likesCount: 0, commentsCount: 0 }; // Initialize counts
            res.json({ success: true, message: 'Post created.', post: newPost });
        } else {
            return res.status(500).json({ success: false, message: 'Failed to create post.' });
        }
    } catch (error) {
        console.error('Post creation error:', error);
        res.status(500).json({ success: false, message: 'Database error creating post.' });
    }
});

// GET: Fetch all posts for the feed
app.get('/api/posts', async (req, res) => {
    try {
        const posts = await db.getAllPosts();
        res.json({ success: true, posts });
    } catch (error) {
        console.error('Feed fetch error:', error);
        res.status(500).json({ success: false, message: 'Database error fetching posts.' });
    }
});

// NEW: POST a comment
app.post('/api/comment', async (req, res) => {
    const { post_id, user_id, username, content } = req.body;
    if (!post_id || !user_id || !content) {
        return res.status(400).json({ success: false, message: 'Post ID, User ID, and content are required.' });
    }

    try {
        const commentId = uuidv4();
        const success = await db.createComment(commentId, post_id, user_id, username, content);

        if (success) {
            const newComment = { id: commentId, post_id, user_id, username, content, timestamp: new Date().toISOString() };

            // Broadcast the new comment to all connected clients for real-time update
            io.emit('commentUpdate', {
                postId: post_id,
                newComment: newComment,
                newCount: await db.getCommentCount(post_id)
            });

            res.json({ success: true, message: 'Comment created.', comment: newComment });
        } else {
            return res.status(500).json({ success: false, message: 'Failed to create comment.' });
        }
    } catch (error) {
        console.error('Comment creation error:', error);
        res.status(500).json({ success: false, message: 'Database error creating comment.' });
    }
});

// NEW: GET comments for a specific post
app.get('/api/comments/:postId', async (req, res) => {
    const { postId } = req.params;
    try {
        const comments = await db.getCommentsForPost(postId);
        res.json({ success: true, comments });
    } catch (error) {
        console.error('Comment fetch error:', error);
        res.status(500).json({ success: false, message: 'Database error fetching comments.' });
    }
});

// GET: Fetch private chat history between two users
app.get('/api/chat/:recipientId', async (req, res) => {
    const { recipientId } = req.params;
    const { senderId } = req.query; // Assuming senderId is passed as a query param for simplicity/testing

    if (!senderId || !recipientId) {
        return res.status(400).json({ success: false, message: 'Both senderId and recipientId are required.' });
    }

    try {
        const messages = await db.getChatHistory(senderId, recipientId);
        res.json({ success: true, messages });
    } catch (error) {
        console.error('Chat history fetch error:', error);
        res.status(500).json({ success: false, message: 'Server error fetching chat history.' });
    }
});


// --- WebSocket (Socket.io) Logic ---

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // --- 1. User Presence and Real-time Chat ---

    // A user logs in or reconnects
    socket.on('userOnline', async (data) => {
        const { userId, username } = data;
        if (!userId) return;

        try {
            await db.userIsOnline(userId, socket.id, username);
            socket.userId = userId; // Attach userId to the socket for easy lookup
            broadcastOnlineUsers();
            console.log(`${username} (${userId}) is now online.`);
        } catch (err) {
            console.error('Error setting user online:', err);
        }
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
        console.log('User disconnected:', socket.id);
        try {
            await db.userIsOffline(socket.id);
            broadcastOnlineUsers();
        } catch (err) {
            console.error('Error setting user offline:', err);
        }
    });

    // Handle private messages
    socket.on('privateMessage', async (data) => {
        const { senderId, recipientId, message } = data;
        if (!senderId || !recipientId || !message) return;

        try {
            // 1. Save the message to the database
            await db.savePrivateMessage(senderId, recipientId, message);

            // 2. Prepare the full message object
            const fullMsg = {
                sender_id: senderId,
                recipient_id: recipientId,
                message: message,
                timestamp: new Date().toISOString()
            };

            // 2. Deliver the message to the recipient if they are online
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

    // --- 3. Feed and Likes ---

    socket.on('newPost', (post) => {
        socket.broadcast.emit('updateFeed', post);
    });

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

    // Note: The comment real-time update is handled by the `io.emit('commentUpdate', ...)`
    // inside the `app.post('/api/comment', ...)` route, so no new `socket.on` is needed here.
});


// --- Server Start ---
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});