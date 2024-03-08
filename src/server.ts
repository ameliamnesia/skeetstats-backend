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
import fs, { write } from 'fs';
import mysql from 'mysql';
import cron from 'node-cron';
import { writeLog } from './util.js';
dotenv.config();

export const app = express();
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

// 7 day stats
app.get('/api/stats/:userdid', (req: Request, res: Response) => {
  const { userdid } = req.params;
  const filterDid = userdid.replace(/[@'";]/g, ''); //strip leading @ and prevent sqli
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const pageSize = 7;
  const offset = (page - 1) * pageSize;

  try {
    const query = `
      SELECT date,
        CONCAT(followersCount, ' (', COALESCE(followersCount - LAG(followersCount) OVER (ORDER BY date), 0), ')') AS followersCount,
        CONCAT(followsCount, ' (', COALESCE(followsCount - LAG(followsCount) OVER (ORDER BY date), 0), ')') AS followsCount,
        CONCAT(postsCount, ' (', COALESCE(postsCount - LAG(postsCount) OVER (ORDER BY date), 0), ')') AS postsCount
      FROM stats WHERE did = ? ORDER BY date DESC LIMIT ? OFFSET ?`;
    connection.query(query, [filterDid, pageSize, offset], (err, results) => {
      if (err) {
        console.error('Error fetching stats:', err);
        writeLog('error.log', (`Error fetching stats: ${err}`))
        res.status(500).json({ error: 'Internal Server Error' });
      } else {
        res.json(results);
      }
    });
  } catch (err) {
    console.error('Error executing query', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

//30 day charts
app.get('/api/charts/:userdid', (req: Request, res: Response) => {
  const { userdid } = req.params;
  const filterDid = userdid.replace(/[@'";]/g, ''); //strip leading @ and prevent sqli
  try {
    const query = `SELECT date, followersCount, followsCount, postsCount FROM stats WHERE did = ? AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ORDER BY date ASC`;
    connection.query(query, [filterDid], (err, results) => {
      if (err) {
        writeLog('error.log', (`Error fetching chart data: ${err}`))
        res.status(500).json({ error: 'Internal Server Error' });
      } else {
        res.json(results);
      }
    });
  } catch (err) {
    console.error('Error executing query', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

//count best days endpoint
app.get('/api/mostincreased/:userdid', (req, res) => {
  const { userdid } = req.params;
  const filterDid = userdid.replace(/[@'";]/g, ''); //strip leading @ and prevent sqli

  if (!userdid) {
    return res.status(400).json({ error: 'Missing did parameter' });
  }
  try {
    // Query to find the date with the most increase in postsCount
    const postsCountQuery = `
  SELECT date, MAX(postsCount - prev_postsCount) AS postsCountIncrease
  FROM (
      SELECT s.date, s.postsCount, 
             @prev_postsCount AS prev_postsCount,
             @prev_postsCount := s.postsCount
      FROM stats s
      CROSS JOIN (SELECT @prev_postsCount := NULL) AS init
      WHERE s.did = ?
      ORDER BY s.date
  ) AS subquery
  GROUP BY date
  ORDER BY postsCountIncrease DESC
  LIMIT 1;
  `;

    // Query to find the date with the most increase in followersCount
    const followersCountQuery = `
  SELECT date, MAX(followersCount - prev_followersCount) AS followersCountIncrease
  FROM (
      SELECT s.date, s.followersCount, 
             @prev_followersCount AS prev_followersCount,
             @prev_followersCount := s.followersCount
      FROM stats s
      CROSS JOIN (SELECT @prev_followersCount := NULL) AS init
      WHERE s.did = ?
      ORDER BY s.date
  ) AS subquery
  GROUP BY date
  ORDER BY followersCountIncrease DESC
  LIMIT 1;
  `;

    // Query to find the date with the most increase in followsCount
    const followsCountQuery = `
  SELECT date, MAX(followsCount - prev_followsCount) AS followsCountIncrease
  FROM (
      SELECT s.date, s.followsCount, 
             @prev_followsCount AS prev_followsCount,
             @prev_followsCount := s.followsCount
      FROM stats s
      CROSS JOIN (SELECT @prev_followsCount := NULL) AS init
      WHERE s.did = ?
      ORDER BY s.date
  ) AS subquery
  GROUP BY date
  ORDER BY followsCountIncrease DESC
  LIMIT 1;
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
  } catch (err) {
    console.error('Error executing query', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

//get monthly data
app.get('/api/monthly/:userdid', async (req, res) => {
  const userdid = req.params.userdid;
  const filterDid = userdid.replace(/[@'";]/g, '');
  try {
    // Query to get earliest data for each month
    const earliestQuery = `
      SELECT 
          CONCAT(LPAD(MONTH(s.date), 2, '0'), '-', YEAR(s.date)) AS month_year,
          s.followsCount AS earliestFollowsCount,
          s.followersCount AS earliestFollowersCount,
          s.postsCount AS earliestPostsCount
      FROM stats s
      JOIN (
          SELECT MIN(date) AS min_date, YEAR(date) AS year, MONTH(date) AS month
          FROM stats
          WHERE did = ?
          GROUP BY YEAR(date), MONTH(date)
      ) AS min_dates
      ON s.date = min_dates.min_date
      AND YEAR(s.date) = min_dates.year
      AND MONTH(s.date) = min_dates.month
      AND s.did = ?
    `;

    // Query to get latest data for each month
    const latestQuery = `
      SELECT 
          CONCAT(LPAD(MONTH(s.date), 2, '0'), '-', YEAR(s.date)) AS month_year,
          s.followsCount AS latestFollowsCount,
          s.followersCount AS latestFollowersCount,
          s.postsCount AS latestPostsCount
      FROM stats s
      JOIN (
          SELECT MAX(date) AS max_date, YEAR(date) AS year, MONTH(date) AS month
          FROM stats
          WHERE did = ?
          GROUP BY YEAR(date), MONTH(date)
      ) AS max_dates
      ON s.date = max_dates.max_date
      AND YEAR(s.date) = max_dates.year
      AND MONTH(s.date) = max_dates.month
      AND s.did = ?
    `;

    // Execute both queries
    const earliestResults = await executeQuery(earliestQuery, [filterDid, filterDid]);
    const latestResults = await executeQuery(latestQuery, [filterDid, filterDid]);
   
  // Calculate differences
  const diffResults = earliestResults.map((earliest, index) => {
    const latest = latestResults[index];
    return {
      followsCount: latest.latestFollowsCount - earliest.earliestFollowsCount,
      followersCount: latest.latestFollowersCount - earliest.earliestFollowersCount,
      postsCount: latest.latestPostsCount - earliest.earliestPostsCount,
      date: earliest.month_year
    };
  });

  // Return the differences
  res.json(diffResults);
  } catch (error) {
    console.error('Error executing MySQL query:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

async function describeRepo(did) {
  try {
    const repoDesc = await agent.api.com.atproto.repo.describeRepo({ repo: did });
    const repoHandle = repoDesc.data.handle
    return repoHandle
  } catch (error) {
    writeLog('test.log', (`Error fetching repo: ${error}`))
    return null;
  }
}
// Endpoint to get suggested follows by handle
app.get('/api/suggested/:handle', async (req: Request, res: Response) => {
  try {
    const { handle } = req.params;
    await checkSession(backend_did);
    let suggested = await agent.app.bsky.graph.getSuggestedFollowsByActor({ actor: handle });
    const allSugg = suggested.data.suggestions
    const topTen = allSugg.slice(0, 10);
    res.json(topTen);
    //res.json(suggested.data);
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

//resolve handle to did
app.post('/api/resolve/:handle', async (req, res) => {
  try {
    const { handle } = req.params;
    const result = await agent.resolveHandle({ handle });
    let resolved = result.data.did
    res.status(200).json(resolved);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
    //res.redirect('https://skeetstats.xyz/error');
  }
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
  } catch (error) {
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
        const insertQuery = 'INSERT INTO stats (did, followersCount, followsCount, postsCount) VALUES (?, ?, ?, ?)';
        await executeQuery(insertQuery, [gp.data.did, gp.data.followersCount, gp.data.followsCount, gp.data.postsCount]);
      } catch (error) {
        writeLog('stats.log', (`Error processing ${dids ?? 'user'}: ${error.message}`))
        continue;
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
//await deleteReadPosts();
setInterval(selectUnreadPosts, 60000);
setInterval(deleteReadPosts, 24 * 60 * 60 * 1000);
// Start the HTTPS server
https.createServer(sslOptions, app).listen(httpsPort, () => {
  console.log(`Server is running on https://localhost:${httpsPort}`);
});