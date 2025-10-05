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
    // FIX: Joining on u.user_id and calculating likesCount via LEFT JOIN on 'likes' table
    const querySQL = `
        SELECT
            p.*,
            u.username,
            COUNT(l.user_id) AS likesCount
        FROM posts p
        JOIN users u ON p.user_id = u.user_id
        LEFT JOIN likes l ON p.id = l.post_id
        GROUP BY p.id, p.user_id, p.created_at, p.content, p.media_url, u.username
        ORDER BY p.created_at DESC
        LIMIT 20
    `;
    return await query(querySQL);
};

// LIKES
const getLike = async (postId, userId) => {
    const rows = await query('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    return rows[0];
};

const addLike = async (postId, userId) => {
    await query('INSERT INTO likes (post_id, user_id) VALUES (?, ?)', [postId, userId]);
};

const removeLike = async (postId, userId) => {
    await query('DELETE FROM likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
};

const getLikeCount = async (postId) => {
    const rows = await query('SELECT COUNT(*) as newCount FROM likes WHERE post_id = ?', [postId]);
    return rows[0].newCount;
};


// ONLINE USERS
const setOnlineStatus = async (userId, username, socketId) => {
    const sql = `
        INSERT INTO online_users (userId, username, socketId)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE socketId = ?
    `;
    await query(sql, [userId, username, socketId, socketId]);
};

const removeOnlineStatusBySocketId = async (socketId) => {
    await query('DELETE FROM online_users WHERE socketId = ?', [socketId]);
};

const removeOnlineStatusByUserId = async (userId) => {
    await query('DELETE FROM online_users WHERE userId = ?', [userId]);
};

const getOnlineUsers = async () => {
    return await query('SELECT userId, username, socketId FROM online_users');
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

module.exports = {
    findUserByEmail,
    createUser,
    createPost,
    getAllPosts,
    getLike,
    addLike,
    removeLike,
    getLikeCount,
    setOnlineStatus,
    removeOnlineStatusBySocketId,
    removeOnlineStatusByUserId,
    getOnlineUsers,
    savePrivateMessage,
    getChatHistory,
    getRecipientSocketId,
    query
};