import bsky, { AtpSessionData, AtpPersistSessionHandler, AtpSessionEvent, AppBskyActorDefs } from '@atproto/api';
const { BskyAgent } = bsky;
export const agent = new BskyAgent({
  service: 'https://bsky.social',
  persistSession: (evt: AtpSessionEvent, sess?: AtpSessionData) => {
    // store the session-data for reuse
  },
});
import cors from 'cors';
import * as dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import https from 'https';
import fs from 'fs';
import mysql from 'mysql';
import cron from 'node-cron';
import { writeLog } from './util.js';
dotenv.config();

const app = express();
//const port = 3001;
const httpsPort = 8443;

// Load SSL certificate and key 
const sslOptions = {
  key: fs.readFileSync(process.env.KEYPATH!),
  cert: fs.readFileSync(process.env.CERTPATH!),
};

app.use(cors());

const backend_user = await agent.resolveHandle({ handle: process.env.BSKY_USERNAME! });
export const backend_did = backend_user.data.did;

// MySQL Connection Configuration
export const dbConfig = {
  database: process.env.DATABASE!,
  user: process.env.DBUSER!,
  password: process.env.DBPASS!,
  host: process.env.DBSERVER!,
};

import { selectUnreadPosts } from './optin.js';
import { deleteReadPosts } from './optin.js';
import { userBrag } from './optin.js';

export const connection = mysql.createConnection(dbConfig);

// Connect to MySQL
connection.connect((err) => {
  if (err) {
    console.error('Error connecting to MySQL:', err);
    writeLog('error.log', ('Error connecting to MySQL: ' + err))
  } else {
    console.log('Connected to MySQL database');
  }
});

// Endpoint to select all rows from the "stats" table by userdid
app.get('/api/stats/:userdid', (req: Request, res: Response) => {
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
      writeLog('error.log', (`Error fetching stats: ${err}`))
      res.status(500).json({ error: 'Internal Server Error' });
    } else {
      res.json(results);
    }
  });
});

// Endpoint to get profile information by handle
app.get('/api/profile/:handle', async (req: Request, res: Response) => {
  try {
    const { handle } = req.params;
    await checkSession(backend_did);
    let gp = await agent.getProfile({ actor: handle });
    res.json(gp.data);
  } catch (error) {
    console.error('Error fetching user profile data:', error);
    writeLog('error.log', (`Error fetching profile: ${error}`))
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Endpoint to get suggested follows by handle
app.get('/api/suggested/:handle', async (req: Request, res: Response) => {
  try {
    const { handle } = req.params;
    await checkSession(backend_did);
    let suggested = await agent.app.bsky.graph.getSuggestedFollowsByActor({ actor: handle });
    res.json(suggested.data);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    writeLog('error.log', (`Error fetching suggestions: ${error}`))
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/followers/:handle/:cursor?', async (req, res) => {
  let arr: AppBskyActorDefs.ProfileViewBasic[] = [];
  let currentPage = 0;
  const SANITY_PAGE_LIMIT = 5000
  const PAGE_SIZE = 15
  const { handle, cursor } = req.params;
  try {
    const followers = await fetch(`https://api.bsky.app/xrpc/app.bsky.graph.getFollowers?actor=${handle}&cursor=${cursor || ''}&limit=${PAGE_SIZE}`);
    let data = followers.json()
    if (!followers.ok) {
      throw new Error('Failed to fetch data');
    }
    arr = arr.concat(await data);
    res.json(arr);
  } catch (error) {
    console.error('Error fetching followers:', error);
    writeLog('error.log', (`Error fetching followers: ${error}`))
    res.status(500).json({ error: 'Internal Server Error' });
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
      let gp = await agent.getProfile({ actor: dids })

      // Insert the fetched data into the "stats" table
      const insertQuery = 'INSERT INTO stats (did, date, followersCount, followsCount, postsCount) VALUES (?, ?, ?, ?, ?)';
      await executeQuery(insertQuery, [gp.data.did, formattedTime, gp.data.followersCount, gp.data.followsCount, gp.data.postsCount]);
      } catch (error) {
      writeLog('stats.log', (`Error processing ${dids ?? 'user'}: ${error.message}`))
      }
    }
    console.log('Cron job executed successfully');
  } catch (error) {
    console.error('Error during cron job execution:', error);
    writeLog('error.log', (`Error in stats cron job: ${error}`))
  }
});

cron.schedule('00 18 * * *', async () => {
  try {
    await userBrag();
    console.log('bragged successfully');
  } catch (error) {
    console.error('Error during cron job execution:', error);
    writeLog('error.log', (`Error posting users: ${error}`))
  }
});

// Utility function to execute MySQL queries
async function executeQuery(query: string, values?: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    connection.query(query, values, (err, results) => {
      if (err) {
        reject(err);
      } else {
        resolve(results);
      }
    });
  });
}

//Utility function to get profile info
async function userProfile(handle: string): Promise<any> {
  await checkSession(backend_did);
  let strippedHandle = handle.replace(/[^a-zA-Z0-9?.\-=:\s]/g, '');
  let gp = await agent.getProfile({ actor: handle });

  return new Promise((resolve, reject) => {
    resolve(gp.data)
  })
}

export async function login() {
  await agent.login({
    identifier: process.env.BSKY_USERNAME!,
    password: process.env.BSKY_PASSWORD!,
  })
  return agent;
}
// Utility function to select a row from the "session" table by user (did)
export async function getSessionByDid(did: string): Promise<any> {
  const query = 'SELECT * FROM session WHERE user = ?';
  return executeQuery(query, [did]);
}
// Utility function to check session by running agent.resumeSession()
export async function checkSession(did: string): Promise<any> {
  // Get the session data
  const sessionData = await getSessionByDid(did);

  // Check if sessionData is not empty
  if (sessionData && sessionData.length > 0) {
    const { tokens } = sessionData[0];

    // Run agent.resumeSession() on the value of the tokens column
    try {
      const parsed = JSON.parse(tokens);
      await agent.resumeSession(parsed)
    } catch {
      await login();
      const updateQuery = 'UPDATE session SET tokens = ? WHERE user = ?';
      await executeQuery(updateQuery, [JSON.stringify(agent.session), did]);
    }
  } else {
    await login();
    let tokens = JSON.stringify(agent.session)
    const insertQuery = 'INSERT INTO session (user, tokens) VALUES (?, ?) ON DUPLICATE KEY UPDATE tokens = ?';
    await executeQuery(insertQuery, [backend_did, tokens, tokens])
  }
}

await selectUnreadPosts();
await deleteReadPosts();
setInterval(selectUnreadPosts, 60000);
setInterval(deleteReadPosts, 24 * 60 * 60 * 1000);
// Start the HTTPS server
https.createServer(sslOptions, app).listen(httpsPort, () => {
  console.log(`Server is running on https://localhost:${httpsPort}`);
});