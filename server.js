// --- ENVIRONMENT CONFIGURATION ---
require('dotenv').config(); // <--- Load environment variables from .env

// --- Dependencies ---
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const nodemailer = require('nodemailer');
const multer = require('multer'); // <--- NEW: For handling file uploads
const path = require('path'); // <--- NEW: For path manipulation

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

// --- Multer Setup (NEW for Production File Uploads) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Separate destinations based on field name
        if (file.fieldname === 'profilePic') {
            cb(null, 'public/uploads/profile_pics');
        } else {
            // General files (posts, chat media)
            cb(null, 'public/uploads/files');
        }
    },
    filename: (req, file, cb) => {
        // Create unique filenames: userId-timestamp.ext
        const ext = path.extname(file.originalname);
        const userId = req.body.userId || 'unknown';
        cb(null, `${userId}-${Date.now()}${ext}`);
    }
});
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});


// --- Middleware ---
app.use(express.json());
app.use(express.static('public')); // Serve static files, including uploads

// --- Helper Functions ---

/**
 * Broadcasts the current list of online users to all connected clients.
 * MODIFIED to include profile picture URL.
 */
const broadcastOnlineUsers = async () => {
    // NOTE: db.getOnlineUsers() must now return a profile_pic_url field
    const users = await db.getOnlineUsers();
    // Include profilePicUrl for the frontend to render the list
    const userPayload = users.map(u => ({
        userId: u.userId,
        username: u.username,
        profilePicUrl: u.profile_pic_url || '/default-user.png'
    }));
    io.emit('onlineUsers', userPayload);
    console.log(`Broadcasting ${userPayload.length} online users.`);
};


// --- API Routes (Modified/Added) ---

// AUTH: Signup endpoint (MODIFIED to save a default profile pic)
app.post('/api/signup', async (req, res) => {
    const { email, password, username } = req.body;
    if (!email || !password || !username) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        const userId = uuidv4();
        const defaultProfilePicUrl = '/default-user.png'; // Default PFP

        // NOTE: db.createUser must be updated to accept and save profilePicUrl
        const success = await db.createUser(userId, email, hashedPassword, username, defaultProfilePicUrl);

        if (success) {
            res.json({
                success: true,
                message: 'User created successfully.',
                token: 'fake-jwt-token',
                userId,
                username,
                profilePicUrl: defaultProfilePicUrl // NEW
            });
        } else {
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

// AUTH: Login endpoint (MODIFIED to return profile picture URL)
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    try {
        // NOTE: db.findUserByEmail must now return the user's profile_pic_url
        const user = await db.findUserByEmail(email);

        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }

        const match = await bcrypt.compare(password, user.password_hash);

        if (match) {
            res.json({
                success: true,
                message: 'Login successful.',
                token: 'fake-jwt-token',
                userId: user.user_id,
                username: user.username,
                profilePicUrl: user.profile_pic_url || '/default-user.png' // NEW
            });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


// AUTH: Forgot Password endpoint (EXISTING)
app.post('/api/forgot-password', async (req, res) => {
// ... (existing logic) ...
});

// AUTH: Reset Password endpoint (EXISTING)
app.post('/api/reset-password', async (req, res) => {
// ... (existing logic) ...
});

// PROFILE: Update Profile Picture (NEW Production Ready Route)
app.post('/api/update-profile-pic', upload.single('profilePic'), async (req, res) => {
    // 'profilePic' must match the field name in the frontend FormData
    const userId = req.body.userId; // Sent from frontend via FormData

    if (!userId) {
        return res.status(401).json({ success: false, message: 'Authentication failed. userId missing.' });
    }

    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image file uploaded.' });
    }

    // The URL is relative to the 'public' directory
    const profilePicUrl = `/uploads/profile_pics/${req.file.filename}`;

    try {
        // NOTE: db.updateUserProfilePic must now handle the full URL
        const success = await db.updateUserProfilePic(userId, profilePicUrl);

        if (success) {
            // Broadcast the update to all clients to refresh UI instantly
            io.emit('profileUpdate', { userId, profilePicUrl });

            res.json({
                success: true,
                message: 'Profile picture updated successfully.',
                profilePicUrl
            });
        } else {
             res.status(500).json({ success: false, message: 'Failed to update profile picture in DB.' });
        }

    } catch (error) {
        console.error('Profile picture update error:', error);
        res.status(500).json({ success: false, message: 'Server error updating profile.' });
    }
});

// FILES: Generic File Upload (NEW for chat/post media)
app.post('/api/upload-file', upload.single('mediaFile'), async (req, res) => {
    // 'mediaFile' must match the field name in the frontend FormData
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    // The URL is relative to the 'public' directory
    const fileUrl = `/uploads/files/${req.file.filename}`;

    res.json({
        success: true,
        message: 'File uploaded successfully.',
        fileUrl,
        originalName: req.file.originalname // Useful for display
    });
});


// POSTS: Get all posts (MODIFIED to fetch mediaUrl and profilePicUrl)
app.get('/api/posts', async (req, res) => {
    try {
        // NOTE: db.getAllPosts must be updated to JOIN with user info to include profilePicUrl
        const posts = await db.getAllPosts();
        res.json(posts);
    } catch (error) {
        console.error('Error fetching posts:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch posts.' });
    }
});

// POSTS: Create new post (MODIFIED to handle mediaUrl)
app.post('/api/posts', async (req, res) => {
    const { userId, username, content, mediaUrl, profilePicUrl } = req.body; // profilePicUrl included for instant broadcast

    if (!userId || !username || (!content && !mediaUrl)) {
        return res.status(400).json({ success: false, message: 'Content or media URL is required.' });
    }
    try {
        const postId = uuidv4();
        // NOTE: db.createPost must be updated to save the mediaUrl
        const success = await db.createPost(postId, userId, username, content, mediaUrl);

        if (success) {
            // Fetch the newly created post (or construct it) for the broadcast
            const newPost = {
                postId, userId, username, content, mediaUrl,
                timestamp: new Date().toISOString(), likeCount: 0,
                profilePicUrl // Include PFP URL for immediate client rendering
            };
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

// COMMENTS: Get comments for a post (EXISTING, logic assumes profilePicUrl is fetched)
app.get('/api/posts/:postId/comments', async (req, res) => {
// ... (existing logic) ...
});

// COMMENTS: Add a comment (EXISTING, logic assumes profilePicUrl is fetched)
app.post('/api/posts/:postId/comments', async (req, res) => {
// ... (existing logic) ...
});

// PROFILE: Update profile picture URL (REMOVED/REPLACED by /api/update-profile-pic, but kept for legacy update path)
app.post('/api/profile/picture', async (req, res) => {
    // It's highly recommended to deprecate this route and use /api/update-profile-pic
    const { userId, url } = req.body;
    if (!userId || !url) {
        return res.status(400).json({ success: false, message: 'User ID and URL are required.' });
    }

    try {
        const success = await db.updateUserProfilePic(userId, url);
        if (success) {
            // Broadcast the update to all clients to refresh UI instantly
            io.emit('profileUpdate', { userId, profilePicUrl: url }); // Added socket broadcast
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
    // ... (existing logic) ...
    });

    // --- 2. Private Chat ---

    // requestChatHistory (MODIFIED to align with potential file attachments)
    socket.on('requestChatHistory', async (data) => {
        const { senderId, recipientId } = data;
        try {
            // NOTE: db.getChatHistory must return messages that can include media URLs in the message_text/content
            const history = await db.getChatHistory(senderId, recipientId);
            socket.emit('chatHistory', { recipientId, history });
        } catch (err) {
            console.error("Error fetching chat history:", err);
        }
    });

    socket.on('privateMessage', async (data) => {
        const { senderId, recipientId, message } = data; // message can now contain file URL tag
        const timestamp = new Date().toISOString();

        if (!senderId || !recipientId || !message) {
            return;
        }

        try {
            // 1. Save the message to the database (full message content, including file URL tag)
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
    // ... (existing logic) ...
    });
});

// --- Server Startup ---
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});