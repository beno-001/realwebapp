// --- Dependencies ---
const mysql = require('mysql2/promise'); // Using mysql2/promise for better async support

// --- DATABASE CONFIGURATION ---
// Configuration is set to RELY ENTIRELY on Environment Variables (process.env).
// The application will crash if the necessary variables are not set at runtime.
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // Ensure the port is parsed as an integer
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : undefined,

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

console.log('Database connection pool initialized.');

// --- CORE UTILITY FUNCTION ---

/**
 * Executes a raw SQL query using the connection pool.
 * @param {string} sql - The SQL query string.
 * @param {Array} params - Parameters to be safely escaped by the database.
 * @returns {Promise<Array>} The query result rows.
 */
const query = async (sql, params) => {
    try {
        const [rows] = await pool.execute(sql, params);
        return rows;
    } catch (error) {
        // Log the full error internally, but rethrow a generic error
        console.error("Database Query Error:", error.code, error.sqlMessage);
        console.error("SQL:", sql);
        console.error("Params:", params);
        throw new Error('Could not execute database query.');
    }
};

// --- USER MANAGEMENT FUNCTIONS ---

const findUserByEmail = async (email) => {
    // FIX: Selecting 'user_id' instead of the non-existent 'id'
    const rows = await query('SELECT user_id, password_hash, username FROM users WHERE email = ?', [email]);
    return rows[0]; // Returns the first user or undefined
};

const createUser = async (userId, email, passwordHash, username) => {
    // FIX: Explicitly inserting the pre-generated 'user_id' UUID
    const result = await query(
        'INSERT INTO users (user_id, email, password_hash, username) VALUES (?, ?, ?, ?)',
        [userId, email, passwordHash, username]
    );
    return result.affectedRows > 0;
};

/**
 * NEW: Saves a password reset token for a user with a 1-hour expiry.
 */
const savePasswordResetToken = async (userId, token) => {
    // Set expiry to 1 hour from now (in MySQL DATETIME format)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    // Delete any existing token for this user first for a clean state
    await query('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);

    const result = await query(
        'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
        [userId, token, expiresAt]
    );
    return result.affectedRows > 0;
};

/**
 * NEW: Finds a user associated with a valid (non-expired) token.
 */
const findUserByToken = async (token) => {
    // Joins users and reset tokens, checks if the token is not expired (expires_at > NOW())
    const sql = `
        SELECT u.user_id, u.username, u.email
        FROM users u
        JOIN password_reset_tokens prt ON u.user_id = prt.user_id
        WHERE prt.token = ? AND prt.expires_at > NOW()
    `;
    const rows = await query(sql, [token]);
    return rows[0]; // Returns user data if found and token is valid
};

/**
 * NEW: Updates a user's password hash.
 */
const updateUserPassword = async (userId, newHashedPassword) => {
    const result = await query(
        'UPDATE users SET password_hash = ? WHERE user_id = ?',
        [newHashedPassword, userId]
    );
    return result.affectedRows > 0;
};

/**
 * NEW: Deletes a token (marks it as used/invalidates it).
 */
const deletePasswordResetToken = async (token) => {
    const result = await query('DELETE FROM password_reset_tokens WHERE token = ?', [token]);
    return result.affectedRows > 0;
};

// --- POST AND INTERACTION FUNCTIONS ---

const createPost = async (postId, userId, username, content, mediaUrl) => {
    // FIX: Explicitly inserting the pre-generated 'id' UUID
    const result = await query(
        'INSERT INTO posts (id, user_id, username, content, media_url) VALUES (?, ?, ?, ?, ?)',
        [postId, userId, username, content, mediaUrl]
    );
    return result.affectedRows > 0;
};

const getAllPosts = async () => {
    const sql = `
        SELECT
            p.id AS postId,
            p.user_id AS userId,
            p.username,
            p.content,
            p.media_url AS mediaUrl,
            p.created_at AS timestamp,
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id) AS likeCount,
            u.profile_pic_url AS profilePicUrl
        FROM posts p
        JOIN users u ON p.user_id = u.user_id
        ORDER BY p.created_at DESC
    `;
    const posts = await query(sql);
    return posts;
};

const getLike = async (postId, userId) => {
    const rows = await query('SELECT * FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    return rows[0];
};

const addLike = async (postId, userId) => {
    const result = await query('INSERT INTO likes (post_id, user_id) VALUES (?, ?)', [postId, userId]);
    return result.affectedRows > 0;
};

const removeLike = async (postId, userId) => {
    const result = await query('DELETE FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    return result.affectedRows > 0;
};

const getLikeCount = async (postId) => {
    const rows = await query('SELECT COUNT(*) AS count FROM likes WHERE post_id = ?', [postId]);
    return rows[0] ? rows[0].count : 0;
};

const addComment = async (postId, userId, username, commentText) => {
    const result = await query(
        'INSERT INTO comments (post_id, user_id, username, comment_text) VALUES (?, ?, ?, ?)',
        [postId, userId, username, commentText]
    );
    return result.affectedRows > 0;
};

const getCommentsForPost = async (postId) => {
    const sql = `
        SELECT
            c.comment_id,
            c.user_id AS userId,
            c.username,
            c.comment_text AS text,
            c.created_at AS timestamp,
            u.profile_pic_url AS profilePicUrl
        FROM comments c
        JOIN users u ON c.user_id = u.user_id
        WHERE c.post_id = ?
        ORDER BY c.created_at ASC
    `;
    return await query(sql, [postId]);
};

// --- PROFILE MANAGEMENT ---

const getUserProfilePic = async (userId) => {
    const rows = await query('SELECT profile_pic_url FROM users WHERE user_id = ?', [userId]);
    return rows[0] ? rows[0].profile_pic_url : null;
};

const updateUserProfilePic = async (userId, url) => {
    const result = await query('UPDATE users SET profile_pic_url = ? WHERE user_id = ?', [url, userId]);
    return result.affectedRows > 0;
};


// --- REAL-TIME USERS AND CHAT ---

const registerOnlineUser = async (userId, username, socketId) => {
    // Upsert logic: Delete if exists, then insert.
    await query('DELETE FROM online_users WHERE userId = ?', [userId]);
    const result = await query(
        'INSERT INTO online_users (userId, username, socketId) VALUES (?, ?, ?)',
        [userId, username, socketId]
    );
    return result.affectedRows > 0;
};

const unregisterOnlineUser = async (socketId) => {
    const result = await query('DELETE FROM online_users WHERE socketId = ?', [socketId]);
    return result.affectedRows > 0;
};

const getOnlineUsers = async () => {
    // FIX: Select userId instead of id to match schema/client
    return await query('SELECT userId, username FROM online_users');
};


// PRIVATE MESSAGES
const savePrivateMessage = async (senderId, recipientId, message) => {
    const result = await query(
        'INSERT INTO messages (sender_id, recipient_id, message_text) VALUES (?, ?, ?)',
        [senderId, recipientId, message]
    );
    return result.affectedRows > 0;
};

const getChatHistory = async (senderId, recipientId) => {
    // FIX: Selecting message_id and created_at to match schema
    const sql = `
        SELECT
            message_id,
            sender_id,
            message_text AS message,
            created_at AS timestamp
        FROM messages
        WHERE
            (sender_id = ? AND recipient_id = ?) OR
            (sender_id = ? AND recipient_id = ?)
        ORDER BY created_at ASC
    `;
    return await query(sql, [senderId, recipientId, recipientId, senderId]);
};

const getRecipientSocketId = async (recipientId) => {
    const rows = await query('SELECT socketId FROM online_users WHERE userId = ?', [recipientId]);
    return rows[0] ? rows[0].socketId : null;
};


// --- MODULE EXPORTS ---
module.exports = {
    findUserByEmail,
    createUser,
    // NEW PASSWORD RESET EXPORTS
    savePasswordResetToken,
    findUserByToken,
    updateUserPassword,
    deletePasswordResetToken,
    // Existing Exports
    createPost,
    getAllPosts,
    getLike,
    addLike,
    removeLike,
    getLikeCount,
    addComment,
    getCommentsForPost,
    getUserProfilePic,
    updateUserProfilePic,
    getOnlineUsers,
    registerOnlineUser,
    unregisterOnlineUser,
    savePrivateMessage,
    getChatHistory,
    getRecipientSocketId,
};