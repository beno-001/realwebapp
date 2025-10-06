// server.js - Ready to Paste Code

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const db = require('./db'); // The updated db.js
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Middleware and Configuration ---
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session setup
const sessionMiddleware = session({
    secret: 'a_very_secret_key_for_realtime_app',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
});
app.use(sessionMiddleware);

// Make session available to Socket.IO
io.engine.use(sessionMiddleware);

// --- AUTHENTICATION ROUTES ---

const isAuthenticated = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'Not authenticated' });
    }
};

app.post('/register', async (req, res) => {
    // UPDATED: Destructure profilePicUrl from the request body
    const { email, password, username, profilePicUrl } = req.body;

    if (!email || !password || !username) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    try {
        const existingUser = await db.findUserByEmail(email);
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'Email already registered.' });
        }

        const userId = uuidv4();
        const passwordHash = await bcrypt.hash(password, 10);

        // Use db.createUser with the profilePicUrl (or null if empty)
        // NOTE: The profilePicUrl argument is now expected by the updated db.js createUser function.
        // Since db.js was updated to use 'NULL' if not provided, we pass the value.
        const success = await db.createUser(userId, email, passwordHash, username, profilePicUrl || null);

        if (success) {
            res.json({ success: true, message: 'Registration successful. Please log in.' });
        } else {
            res.status(500).json({ success: false, message: 'Registration failed.' });
        }
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});


app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    try {
        const user = await db.findUserByEmail(email);

        if (user && await bcrypt.compare(password, user.password_hash)) {
            // Store essential user info (including profile pic URL) in the session
            req.session.user = {
                id: user.user_id,
                username: user.username,
                profilePicUrl: user.profile_pic_url
            };
            // Return profilePicUrl to the client
            res.json({ success: true, username: user.username, profilePicUrl: user.profile_pic_url, userId: user.user_id });
        } else {
            res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

app.post('/logout', (req, res) => {
    if (req.session.user) {
        req.session.destroy(err => {
            if (err) {
                console.error('Session destroy error:', err);
                return res.status(500).json({ success: false, message: 'Could not log out.' });
            }
            res.json({ success: true, message: 'Logged out successfully.' });
        });
    } else {
        res.json({ success: true, message: 'Already logged out.' });
    }
});

app.get('/check-auth', (req, res) => {
    if (req.session.user) {
        // Send profilePicUrl on auth check
        res.json({ success: true, user: { id: req.session.user.id, username: req.session.user.username, profilePicUrl: req.session.user.profilePicUrl } });
    } else {
        res.json({ success: false });
    }
});

// --- POST ROUTES ---

// NEW: Endpoint to get comment count (for initial feed loading)
app.get('/api/posts/:postId/comments/count', isAuthenticated, async (req, res) => {
    try {
        const count = await db.getCommentCount(req.params.postId);
        res.json({ success: true, count: count });
    } catch (err) {
        console.error('Error fetching comment count:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch comment count.' });
    }
});

app.get('/api/posts', isAuthenticated, async (req, res) => {
    try {
        const posts = await db.getAllPosts();
        res.json({ success: true, posts });
    } catch (err) {
        console.error('Error fetching posts:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch posts.' });
    }
});

app.post('/api/posts', isAuthenticated, async (req, res) => {
    const { content, mediaUrl } = req.body;
    const { id: userId, username } = req.session.user;

    if (!content && !mediaUrl) {
        return res.status(400).json({ success: false, message: 'Post must have content or media.' });
    }

    try {
        const postId = uuidv4();
        const success = await db.createPost(postId, userId, username, content, mediaUrl);

        if (success) {
            // Construct the post object to broadcast
            const newPost = {
                id: postId,
                user_id: userId,
                username: username,
                content: content,
                media_url: mediaUrl,
                created_at: new Date().toISOString(),
                likesCount: 0,
                // Add the user's profile pic url for the client to render
                profile_pic_url: req.session.user.profilePicUrl
            };
            io.emit('newPost', newPost);
            res.json({ success: true, post: newPost });
        } else {
            res.status(500).json({ success: false, message: 'Post creation failed.' });
        }
    } catch (err) {
        console.error('Error creating post:', err);
        res.status(500).json({ success: false, message: 'Server error during post creation.' });
    }
});

// --- SOCKET.IO LOGIC ---

io.on('connection', (socket) => {
    const session = socket.request.session;
    const user = session.user;

    if (user) {
        console.log(`User connected: ${user.username} (${user.id})`);

        // Set user as online and broadcast the list
        db.setOnlineStatus(user.id, user.username, socket.id)
            .then(async () => {
                const onlineUsers = await db.getOnlineUsers();
                io.emit('onlineUsers', onlineUsers);
            })
            .catch(err => console.error('Error setting online status:', err));
    } else {
        console.log('Unauthenticated user connected.');
    }

    // LIKES
    socket.on('likePost', async (postId) => {
        if (!user) return;
        try {
            const isLiked = await db.getLike(postId, user.id);
            if (isLiked) {
                await db.removeLike(postId, user.id);
            } else {
                await db.addLike(postId, user.id);
            }

            const newCount = await db.getLikeCount(postId);
            io.emit('likeCountUpdate', { postId, newCount });
        } catch (err) {
            console.error('Error handling likePost:', err);
        }
    });

    // --- COMMENTS (NEW) ---

    // Handler to load comments when a user clicks the comment button
    socket.on('loadComments', async (postId) => {
        if (!user) return;
        try {
            const comments = await db.getCommentsByPostId(postId);
            // Send the comments back ONLY to the requesting socket
            socket.emit('postComments', { postId, comments });
        } catch (err) {
            console.error('Error handling loadComments:', err);
        }
    });

    // Handler to submit a new comment
    socket.on('addComment', async (data) => {
        if (!user) return;
        const { postId, content } = data;
        const commentId = uuidv4();

        try {
            const success = await db.addComment(commentId, postId, user.id, user.username, content);

            if (success) {
                const profilePicUrl = user.profilePicUrl;

                // Create the full comment object to broadcast
                const newComment = {
                    id: commentId,
                    postId: postId,
                    userId: user.id,
                    username: user.username,
                    content: content,
                    created_at: new Date().toISOString(),
                    profile_pic_url: profilePicUrl
                };

                io.emit('newComment', newComment);

                const newCount = await db.getCommentCount(postId);
                io.emit('commentCountUpdate', { postId, newCount });
            }
        } catch (err) {
            console.error("Error handling addComment:", err);
        }
    });


    // PRIVATE MESSAGES
    socket.on('privateMessage', async ({ recipientId, message }) => {
        if (!user || !recipientId || !message) return;

        try {
            const success = await db.savePrivateMessage(user.id, recipientId, message);
            if (success) {
                const recipientSocketId = await db.getRecipientSocketId(recipientId);

                const messageData = {
                    senderId: user.id,
                    senderUsername: user.username,
                    message: message,
                    timestamp: new Date().toISOString()
                };

                // 1. Send to recipient (if online)
                if (recipientSocketId) {
                    io.to(recipientSocketId).emit('privateMessage', messageData);
                }

                // 2. Send back to sender
                socket.emit('privateMessage', messageData);

            }
        } catch (err) {
            console.error('Error saving or sending private message:', err);
        }
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);

        // Remove user from online list and broadcast the update
        db.removeOnlineStatusBySocketId(socket.id)
            .then(async () => {
                const onlineUsers = await db.getOnlineUsers();
                io.emit('onlineUsers', onlineUsers);
            })
            .catch(err => console.error('Error removing online status:', err));
    });
});

// --- SERVER STARTUP ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});