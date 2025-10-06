// --- ENVIRONMENT CONFIGURATION ---
require('dotenv').config(); // <--- NEW: Load environment variables from .env

// --- Dependencies ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const nodemailer = require('nodemailer'); // <--- NEW: Import Nodemailer

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

// --- Nodemailer Setup (NEW) ---
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for 587/2525
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

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
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


// AUTH: Forgot Password endpoint (NEW)
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    try {
        const user = await db.findUserByEmail(email);

        // SECURITY NOTE: Respond with a generic success message even if the user isn't found
        // to prevent potential attackers from enumerating valid email addresses.
        if (!user) {
            // Log a warning, but return success to the user
            console.log(`Password reset requested for unknown email: ${email}`);
            return res.json({ success: true, message: 'A password reset link has been sent to your email address.' });
        }

        const resetToken = uuidv4();
        const userId = user.user_id;

        // 1. Save token and expiry (1 hour expiry is set in db.js function)
        await db.savePasswordResetToken(userId, resetToken);

        // 2. SEND ACTUAL EMAIL HERE
        const resetLink = `http://localhost:${PORT}/?view=reset&token=${resetToken}`;

        const mailOptions = {
            from: `"${process.env.EMAIL_FROM_NAME || 'SupaGram Support'}" <${process.env.SMTP_USER}>`,
            to: user.email,
            subject: 'SupaGram Password Reset Request',
            html: `
                <p>You requested a password reset for your SupaGram account.</p>
                <p>Click the link below to reset your password:</p>
                <p><a href="${resetLink}">Reset Password Link</a></p>
                <p>This link will expire in 1 hour.</p>
                <p>If you did not request this, please ignore this email.</p>
            `,
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log(`Password reset link sent to: ${user.email}`);
            // Log the URL to the console in development for easy testing
            console.log(`[DEV TEST LINK]: ${resetLink}`);
        } catch (emailError) {
            console.error('Error sending password reset email:', emailError.message);
            // If the email fails, we still return success to the user (security)
        }

        res.json({ success: true, message: 'A password reset link has been sent to your email address.' });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, message: 'Server error during password reset request.' });
    }
});

// AUTH: Reset Password endpoint (NEW)
app.post('/api/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
        return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }

    // Basic password strength check
    if (newPassword.length < 8) {
         return res.status(400).json({ success: false, message: 'New password must be at least 8 characters long.' });
    }

    try {
        // 1. Find user by token and check expiry
        const user = await db.findUserByToken(token);

        if (!user) {
            // Return generic error for security
            return res.status(400).json({ success: false, message: 'Invalid or expired reset token.' });
        }

        // 2. Hash new password
        const newHashedPassword = await bcrypt.hash(newPassword, saltRounds);

        // 3. Update password and delete the token (invalide it)
        await db.updateUserPassword(user.user_id, newHashedPassword);
        await db.deletePasswordResetToken(token);

        res.json({ success: true, message: 'Password has been successfully reset. Please log in.' });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: 'Server error during password reset.' });
    }
});


// POSTS: Get all posts
app.get('/api/posts', async (req, res) => {
    try {
        const posts = await db.getAllPosts();
        res.json(posts);
    } catch (error) {
        console.error('Error fetching posts:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch posts.' });
    }
});

// POSTS: Create new post
app.post('/api/posts', async (req, res) => {
    const { userId, username, content, mediaUrl } = req.body;
    if (!userId || !username || (!content && !mediaUrl)) {
        return res.status(400).json({ success: false, message: 'Content or media URL is required.' });
    }
    try {
        const postId = uuidv4();
        const success = await db.createPost(postId, userId, username, content, mediaUrl);

        if (success) {
            // Fetch the newly created post (or construct it) for the broadcast
            const newPost = { postId, userId, username, content, mediaUrl, timestamp: new Date().toISOString(), likeCount: 0 };
            io.emit('updateFeed', newPost); // Broadcast the new post to all clients
            res.json({ success: true, message: 'Post created successfully.', postId });
        } else {
            res.status(500).json({ success: false, message: 'Failed to create post.' });
        }
    } catch (error) {
        console.error('Post creation error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// COMMENTS: Get comments for a post
app.get('/api/posts/:postId/comments', async (req, res) => {
    try {
        const postId = req.params.postId;
        const comments = await db.getCommentsForPost(postId);
        res.json(comments);
    } catch (error) {
        console.error('Error fetching comments:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch comments.' });
    }
});

// COMMENTS: Add a comment
app.post('/api/posts/:postId/comments', async (req, res) => {
    const { userId, username, text } = req.body;
    const postId = req.params.postId;

    if (!userId || !username || !text) {
        return res.status(400).json({ success: false, message: 'User ID, username, and text are required.' });
    }

    try {
        const success = await db.addComment(postId, userId, username, text);
        if (success) {
            // Get the user's current profile pic to send back with the comment
            const profilePicUrl = await db.getUserProfilePic(userId);
            const newComment = { postId, userId, username, text, profilePicUrl, timestamp: new Date().toISOString() };
            // Broadcast the new comment to all connected clients
            io.emit('newComment', newComment);
            res.json({ success: true, message: 'Comment added successfully.', comment: newComment });
        } else {
            res.status(500).json({ success: false, message: 'Failed to add comment.' });
        }
    } catch (error) {
        console.error('Add comment error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// PROFILE: Update profile picture URL
app.post('/api/profile/picture', async (req, res) => {
    const { userId, url } = req.body;
    if (!userId || !url) {
        return res.status(400).json({ success: false, message: 'User ID and URL are required.' });
    }

    try {
        const success = await db.updateUserProfilePic(userId, url);
        if (success) {
            res.json({ success: true, message: 'Profile picture updated successfully.' });
        } else {
            res.status(500).json({ success: false, message: 'Failed to update profile picture.' });
        }
    } catch (error) {
        console.error('Update profile picture error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


// --- WebSocket (Socket.IO) Logic ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // --- 1. User Status ---

    socket.on('userOnline', async (data) => {
        const { userId, username } = data;
        if (!userId || !username) return;

        try {
            await db.registerOnlineUser(userId, username, socket.id);
            broadcastOnlineUsers();
            console.log(`${username} (${userId}) is online.`);
        } catch (err) {
            console.error("Error registering user online:", err);
        }
    });

    socket.on('disconnect', async () => {
        try {
            const success = await db.unregisterOnlineUser(socket.id);
            if (success) {
                broadcastOnlineUsers();
                console.log('User disconnected:', socket.id);
            }
        } catch (err) {
            console.error("Error unregistering user:", err);
        }
    });

    // --- 2. Private Chat ---

    socket.on('requestChatHistory', async (data) => {
        const { senderId, recipientId } = data;
        try {
            const history = await db.getChatHistory(senderId, recipientId);
            socket.emit('chatHistory', { recipientId, history });
        } catch (err) {
            console.error("Error fetching chat history:", err);
        }
    });

    socket.on('privateMessage', async (data) => {
        const { senderId, recipientId, message } = data;
        const timestamp = new Date().toISOString();

        if (!senderId || !recipientId || !message) {
            return;
        }

        try {
            // 1. Save the message to the database
            await db.savePrivateMessage(senderId, recipientId, message);

            const fullMsg = { senderId, recipientId, message, timestamp };

            // 2. Try to send the message to the recipient if they are online
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
});

// --- Server Startup ---
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});