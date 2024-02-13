import bsky from '@atproto/api';
const { BskyAgent } = bsky;
export const agent = new BskyAgent({
    service: 'https://bsky.social',
    persistSession: (evt, sess) => {
        // store the session-data for reuse
    },
});
import cors from 'cors';
import * as dotenv from 'dotenv';
import express from 'express';
import https from 'https';
import fs from 'fs';
import mysql from 'mysql';
import cron from 'node-cron';
import { writeLog } from './util.js';
dotenv.config();
export const app = express();
//const port = 3001;
const httpsPort = 8443;
// Load SSL certificate and key 
const sslOptions = {
    key: fs.readFileSync(process.env.KEYPATH),
    cert: fs.readFileSync(process.env.CERTPATH),
};
app.use(cors());
const backend_user = await agent.resolveHandle({ handle: process.env.BSKY_USERNAME });
export const backend_did = backend_user.data.did;
// MySQL Connection Configuration
export const dbConfig = {
    database: process.env.DATABASE,
    user: process.env.DBUSER,
    password: process.env.DBPASS,
    host: process.env.DBSERVER,
};
import { selectUnreadPosts } from './optin.js';
import { deleteReadPosts } from './optin.js';
import { userBrag } from './optin.js';
export const connection = mysql.createConnection(dbConfig);
// Connect to MySQL
connection.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        writeLog('error.log', ('Error connecting to MySQL: ' + err));
    }
    else {
        console.log('Connected to MySQL database');
    }
});
// Endpoint to select all rows from the "stats" table by userdid
app.get('/api/stats/:userdid', (req, res) => {
    const { userdid } = req.params;
    const filterDid = userdid.replace(/[@'";]/g, ''); //strip leading @ and prevent sqli
    const query = `SELECT
    date,
    CONCAT(followersCount, ' (', COALESCE(followersCount - LAG(followersCount) OVER (ORDER BY date), 0), ')') AS followersCount,
    CONCAT(followsCount, ' (', COALESCE(followsCount - LAG(followsCount) OVER (ORDER BY date), 0), ')') AS followsCount,
    CONCAT(postsCount, ' (', COALESCE(postsCount - LAG(postsCount) OVER (ORDER BY date), 0), ')') AS postsCount
  FROM
    stats
  WHERE
    did = ?
  ORDER BY
    date DESC
    LIMIT 7`;
    connection.query(query, [filterDid], (err, results) => {
        if (err) {
            console.error('Error fetching stats:', err);
            writeLog('error.log', (`Error fetching stats: ${err}`));
            res.status(500).json({ error: 'Internal Server Error' });
        }
        else {
            res.json(results);
        }
    });
});
// Stats for charts
app.get('/api/charts/:userdid', (req, res) => {
    const { userdid } = req.params;
    const filterDid = userdid.replace(/[@'";]/g, ''); //strip leading @ and prevent sqli
    const query = `SELECT date, followersCount, followsCount, postsCount FROM stats WHERE did = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ORDER BY date ASC`;
    connection.query(query, [filterDid], (err, results) => {
        if (err) {
            writeLog('error.log', (`Error fetching chart data: ${err}`));
            res.status(500).json({ error: 'Internal Server Error' });
        }
        else {
            res.json(results);
        }
    });
});
// Endpoint to get profile information by handle
app.get('/api/profile/:handle', async (req, res) => {
    try {
        const { handle } = req.params;
        await checkSession(backend_did);
        let gp = await agent.getProfile({ actor: handle });
        res.json(gp.data);
    }
    catch (error) {
        console.error('Error fetching user profile data:', error);
        writeLog('error.log', (`Error fetching profile: ${error}`));
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
// Endpoint to get suggested follows by handle
app.get('/api/suggested/:handle', async (req, res) => {
    try {
        const { handle } = req.params;
        await checkSession(backend_did);
        let suggested = await agent.app.bsky.graph.getSuggestedFollowsByActor({ actor: handle });
        const allSugg = suggested.data.suggestions;
        const topTen = allSugg.slice(0, 10);
        res.json(topTen);
        //res.json(suggested.data);
    }
    catch (error) {
        console.error('Error fetching suggestions:', error);
        writeLog('error.log', (`Error fetching suggestions: ${error}`));
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/followers/:handle/:cursor?', async (req, res) => {
    let arr = [];
    let currentPage = 0;
    const SANITY_PAGE_LIMIT = 5000;
    const PAGE_SIZE = 15;
    const { handle, cursor } = req.params;
    try {
        const followers = await fetch(`https://api.bsky.app/xrpc/app.bsky.graph.getFollowers?actor=${handle}&cursor=${cursor || ''}&limit=${PAGE_SIZE}`);
        let data = followers.json();
        if (!followers.ok) {
            throw new Error('Failed to fetch data');
        }
        arr = arr.concat(await data);
        res.json(arr);
    }
    catch (error) {
        console.error('Error fetching followers:', error);
        writeLog('error.log', (`Error fetching followers: ${error}`));
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
//resolve handle to did
app.post('/api/resolve/:handle', async (req, res) => {
    try {
        const { handle } = req.params;
        const result = await agent.resolveHandle({ handle });
        let resolved = result.data.did;
        res.status(200).json(resolved);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
//count best days endpoint
app.get('/api/mostincreased/:userdid', (req, res) => {
    const { userdid } = req.params;
    const filterDid = userdid.replace(/[@'";]/g, ''); //strip leading @ and prevent sqli
    if (!userdid) {
        return res.status(400).json({ error: 'Missing did parameter' });
    }
    // Query to find the date with the most increase in postsCount
    const postsCountQuery = `
    SELECT date, MAX(postsCount - prev_postsCount) AS postsCountIncrease
    FROM (
      SELECT date, postsCount, 
             (SELECT postsCount FROM stats s2 WHERE s2.did = s.did AND s2.date < s.date ORDER BY s2.date DESC LIMIT 1) AS prev_postsCount
      FROM stats s
      WHERE did = ?
    ) AS subquery
    GROUP BY date
    ORDER BY postsCountIncrease DESC
    LIMIT 1
  `;
    // Query to find the date with the most increase in followersCount
    const followersCountQuery = `
    SELECT date, MAX(followersCount - prev_followersCount) AS followersCountIncrease
    FROM (
      SELECT date, followersCount, 
             (SELECT followersCount FROM stats s2 WHERE s2.did = s.did AND s2.date < s.date ORDER BY s2.date DESC LIMIT 1) AS prev_followersCount
      FROM stats s
      WHERE did = ?
    ) AS subquery
    GROUP BY date
    ORDER BY followersCountIncrease DESC
    LIMIT 1
  `;
    // Query to find the date with the most increase in followsCount
    const followsCountQuery = `
    SELECT date, MAX(followsCount - prev_followsCount) AS followsCountIncrease
    FROM (
      SELECT date, followsCount, 
             (SELECT followsCount FROM stats s2 WHERE s2.did = s.did AND s2.date < s.date ORDER BY s2.date DESC LIMIT 1) AS prev_followsCount
      FROM stats s
      WHERE did = ?
    ) AS subquery
    GROUP BY date
    ORDER BY followsCountIncrease DESC
    LIMIT 1
  `;
    connection.query(postsCountQuery, [filterDid], (err, postsCountResult) => {
        if (err) {
            console.error('Error querying MySQL for postsCount: ', err);
            return res.status(500).json({ error: 'Internal server error' });
        }
        connection.query(followersCountQuery, [filterDid], (err, followersCountResult) => {
            if (err) {
                console.error('Error querying MySQL for followersCount: ', err);
                return res.status(500).json({ error: 'Internal server error' });
            }
            connection.query(followsCountQuery, [filterDid], (err, followsCountResult) => {
                if (err) {
                    console.error('Error querying MySQL for followsCount: ', err);
                    return res.status(500).json({ error: 'Internal server error' });
                }
                const postsCountIncrease = postsCountResult.length ? postsCountResult[0].postsCountIncrease : 0;
                const followersCountIncrease = followersCountResult.length ? followersCountResult[0].followersCountIncrease : 0;
                const followsCountIncrease = followsCountResult.length ? followsCountResult[0].followsCountIncrease : 0;
                const postsCountDate = postsCountResult.length ? postsCountResult[0].date : null;
                const followersCountDate = followersCountResult.length ? followersCountResult[0].date : null;
                const followsCountDate = followsCountResult.length ? followsCountResult[0].date : null;
                res.json({
                    followersCountDate,
                    followersCountIncrease,
                    followsCountDate,
                    followsCountIncrease,
                    postsCountDate,
                    postsCountIncrease
                });
            });
        });
    });
});
// Autocomplete endpoint
app.use(express.json());
app.post('/autocomplete', async (req, res) => {
    await checkSession(backend_did);
    try {
        const { query } = req.body;
        if (!query) {
            return res.status(400).json({ error: 'Missing search query (q) in request body.' });
        }
        const autoCompleteResults = await agent.searchActorsTypeahead({ q: query });
        res.json({ results: autoCompleteResults.data.actors });
    }
    catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
//REDIRECT, DO NOT PUT ANY ROUTES AFTER THIS//
app.get('*', (req, res) => {
    res.redirect('https://skeetstats.xyz');
});
//REDIRECT, DO NOT PUT ANY ROUTES AFTER THIS//
cron.schedule('00 23 * * *', async () => {
    await checkSession(backend_did);
    const currentTime = new Date();
    const formattedTime = `${currentTime.getFullYear()}-${(currentTime.getMonth() + 1).toString().padStart(2, '0')}-${currentTime.getDate().toString().padStart(2, '0')} ${currentTime.getHours().toString().padStart(2, '0')}:${currentTime.getMinutes().toString().padStart(2, '0')}:${currentTime.getSeconds().toString().padStart(2, '0')}`;
    try {
        // Select all rows from the "opted_in" table
        const selectQuery = 'SELECT dids FROM opted_in';
        const optedInRows = await executeQuery(selectQuery);
        // Process each row and insert data into the "stats" table
        for (const optedInRow of optedInRows) {
            const { dids } = optedInRow;
            try {
                // Fetch data using the agent.getProfile
                let gp = await agent.getProfile({ actor: dids });
                // Insert the fetched data into the "stats" table
                const insertQuery = 'INSERT INTO stats (did, date, followersCount, followsCount, postsCount) VALUES (?, ?, ?, ?, ?)';
                await executeQuery(insertQuery, [gp.data.did, formattedTime, gp.data.followersCount, gp.data.followsCount, gp.data.postsCount]);
            }
            catch (error) {
                writeLog('stats.log', (`Error processing ${dids ?? 'user'}: ${error.message}`));
                continue;
            }
        }
        console.log('Cron job executed successfully');
    }
    catch (error) {
        console.error('Error during cron job execution:', error);
        writeLog('error.log', (`Error in stats cron job: ${error}`));
    }
});
cron.schedule('00 18 * * *', async () => {
    try {
        await userBrag();
        console.log('bragged successfully');
    }
    catch (error) {
        console.error('Error during cron job execution:', error);
        writeLog('error.log', (`Error posting users: ${error}`));
    }
});
// Utility function to execute MySQL queries
async function executeQuery(query, values) {
    return new Promise((resolve, reject) => {
        connection.query(query, values, (err, results) => {
            if (err) {
                reject(err);
            }
            else {
                resolve(results);
            }
        });
    });
}
//Utility function to get profile info
async function userProfile(handle) {
    await checkSession(backend_did);
    let strippedHandle = handle.replace(/[^a-zA-Z0-9?.\-=:\s]/g, '');
    let gp = await agent.getProfile({ actor: handle });
    return new Promise((resolve, reject) => {
        resolve(gp.data);
    });
}
export async function login() {
    await agent.login({
        identifier: process.env.BSKY_USERNAME,
        password: process.env.BSKY_PASSWORD,
    });
    return agent;
}
// Utility function to select a row from the "session" table by user (did)
export async function getSessionByDid(did) {
    const query = 'SELECT * FROM session WHERE user = ?';
    return executeQuery(query, [did]);
}
// Utility function to check session by running agent.resumeSession()
export async function checkSession(did) {
    // Get the session data
    const sessionData = await getSessionByDid(did);
    // Check if sessionData is not empty
    if (sessionData && sessionData.length > 0) {
        const { tokens } = sessionData[0];
        // Run agent.resumeSession() on the value of the tokens column
        try {
            const parsed = JSON.parse(tokens);
            await agent.resumeSession(parsed);
        }
        catch {
            await login();
            const updateQuery = 'UPDATE session SET tokens = ? WHERE user = ?';
            await executeQuery(updateQuery, [JSON.stringify(agent.session), did]);
        }
    }
    else {
        await login();
        let tokens = JSON.stringify(agent.session);
        const insertQuery = 'INSERT INTO session (user, tokens) VALUES (?, ?) ON DUPLICATE KEY UPDATE tokens = ?';
        await executeQuery(insertQuery, [backend_did, tokens, tokens]);
    }
}
await selectUnreadPosts();
//await deleteReadPosts();
setInterval(selectUnreadPosts, 60000);
setInterval(deleteReadPosts, 24 * 60 * 60 * 1000);
// Start the HTTPS server
https.createServer(sslOptions, app).listen(httpsPort, () => {
    console.log(`Server is running on https://localhost:${httpsPort}`);
});
